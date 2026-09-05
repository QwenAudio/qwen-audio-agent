package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGatewayProxyPreservesPublicHost(t *testing.T) {
	var receivedHost string
	var forwardedProto string
	targetServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		receivedHost = request.Host
		forwardedProto = request.Header.Get("X-Forwarded-Proto")
		response.WriteHeader(http.StatusNoContent)
	}))
	defer targetServer.Close()

	target, err := url.Parse(targetServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "https://voice.example.ts.net/api/health", nil)
	response := httptest.NewRecorder()
	newGatewayProxy(target).ServeHTTP(response, request)
	_, _ = io.Copy(io.Discard, response.Result().Body)

	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected proxy response: %d", response.Code)
	}
	if receivedHost != "voice.example.ts.net" {
		t.Fatalf("public Host was not preserved: %q", receivedHost)
	}
	if forwardedProto != "https" {
		t.Fatalf("forwarded protocol was not normalized: %q", forwardedProto)
	}
}

func TestTrimEventURLRemovesSentencePunctuation(t *testing.T) {
	got := trimEventURL("https://tailscale.com/s/https.)")
	if got != "https://tailscale.com/s/https" {
		t.Fatalf("unexpected action URL: %q", got)
	}
}
