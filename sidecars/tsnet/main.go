// qwaudio-tsnet publishes a loopback Qwen Audio Agent Gateway through
// Tailscale Funnel. It is an implementation detail of Gateway remote access,
// not a second Gateway and not a client-facing protocol endpoint.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

var (
	authURLPattern   = regexp.MustCompile(`https://login\.tailscale\.com/[[:graph:]]+`)
	actionURLPattern = regexp.MustCompile(`https://tailscale\.com/[[:graph:]]+`)
	errorCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]+$`)
)

type eventWriter struct {
	mu sync.Mutex
}

func (w *eventWriter) emit(eventType string, fields map[string]any) {
	message := map[string]any{"type": eventType}
	for key, value := range fields {
		message[key] = value
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := json.NewEncoder(os.Stdout).Encode(message); err != nil {
		log.Printf("write event: %v", err)
	}
}

func main() {
	var gatewayURL string
	var stateDir string
	var hostname string
	var port int
	flag.StringVar(&gatewayURL, "gateway", "http://127.0.0.1:3101", "loopback Gateway URL")
	flag.StringVar(&stateDir, "state-dir", "", "persistent tsnet state directory")
	flag.StringVar(&hostname, "hostname", "qwen-audio-agent", "Tailscale node hostname")
	flag.IntVar(&port, "port", 443, "Funnel HTTPS port")
	flag.Parse()

	events := new(eventWriter)
	if err := run(gatewayURL, stateDir, hostname, port, events); err != nil {
		fields := map[string]any{
			"code":    errorCode(err),
			"message": err.Error(),
		}
		if actionURL := trimEventURL(actionURLPattern.FindString(err.Error())); actionURL != "" {
			fields["action_url"] = actionURL
		}
		events.emit("error", fields)
		os.Exit(1)
	}
}

func run(gatewayURL, stateDir, hostname string, port int, events *eventWriter) error {
	target, err := url.Parse(gatewayURL)
	if err != nil || target.Scheme != "http" || !isLoopback(target.Hostname()) {
		return fmt.Errorf("invalid_gateway: gateway must be a loopback HTTP URL")
	}
	if stateDir == "" {
		return fmt.Errorf("invalid_state_dir: state directory is required")
	}
	if port != 443 && port != 8443 && port != 10000 {
		return fmt.Errorf("invalid_port: Funnel port must be 443, 8443, or 10000")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("state_dir_failed: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	server := &tsnet.Server{
		Dir:      stateDir,
		Hostname: hostname,
		UserLogf: func(format string, args ...any) {
			message := fmt.Sprintf(format, args...)
			if authURL := trimEventURL(authURLPattern.FindString(message)); authURL != "" {
				events.emit("auth_required", map[string]any{"url": authURL})
			}
			log.Print(message)
		},
		Logf: func(format string, args ...any) {
			log.Printf(format, args...)
		},
	}
	defer server.Close()

	events.emit("starting", nil)
	if _, err := server.Up(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return fmt.Errorf("tailscale_start_failed: %w", err)
	}

	listener, err := server.ListenFunnel("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("funnel_start_failed: %w", err)
	}
	defer listener.Close()

	domains := server.CertDomains()
	if len(domains) == 0 {
		return fmt.Errorf("funnel_domain_unavailable: Tailscale did not provide an HTTPS domain")
	}
	endpoint := fmt.Sprintf("https://%s", strings.TrimSuffix(domains[0], "."))
	if port != 443 {
		endpoint = fmt.Sprintf("%s:%d", endpoint, port)
	}

	proxy := newGatewayProxy(target)
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, proxyError error) {
		log.Printf("gateway proxy failed: %v", proxyError)
		http.Error(response, "Gateway is unavailable", http.StatusBadGateway)
	}

	httpServer := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 15 * time.Second,
	}
	events.emit("endpoint_ready", map[string]any{"url": endpoint})

	serveError := make(chan error, 1)
	go func() { serveError <- httpServer.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
		return nil
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("funnel_serve_failed: %w", err)
	}
}

func newGatewayProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		// Gateway distinguishes local management traffic from remote traffic by
		// the public Host header. Preserve it while dialing the loopback target.
		publicHost := request.Host
		originalDirector(request)
		request.Host = publicHost
		request.Header.Set("X-Forwarded-Proto", "https")
	}
	return proxy
}

func isLoopback(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

func trimEventURL(value string) string {
	return strings.TrimRight(value, ".,;:!?)]}")
}

func errorCode(err error) string {
	message := err.Error()
	if index := strings.IndexByte(message, ':'); index > 0 {
		candidate := message[:index]
		if errorCodePattern.MatchString(candidate) {
			return candidate
		}
	}
	return "tsnet_failed"
}
