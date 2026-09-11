#!/usr/bin/env python3
"""Small JSONL process boundary around VoiceMem's public API."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def load_voicemem():
    """Load the optional dependency with one actionable startup failure."""
    try:
        from voicemem import VoiceMem, build_memory_context
    except ModuleNotFoundError as error:
        requirements = Path(__file__).with_name("requirements.txt").resolve()
        if error.name == "voicemem":
            reason = "VoiceMem is not installed for this Python interpreter"
        else:
            reason = (
                "VoiceMem is installed but its dependencies are incomplete "
                f"(missing module: {error.name})"
            )
        print(
            f"{reason}. Install the example dependencies with: "
            f"{sys.executable} -m pip install -r {requirements}",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(3) from None
    except ImportError as error:
        print(
            "VoiceMem could not be imported by "
            f"{sys.executable}: {error}",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(3) from None
    return VoiceMem, build_memory_context


class Runtime:
    def __init__(
        self,
        state_dir: Path,
        voice_mem_class,
        build_memory_context,
        input_mode: str = "text",
    ) -> None:
        self.root = state_dir / "memory-spaces"
        self.root.mkdir(parents=True, exist_ok=True)
        self.input_mode = "audio" if input_mode == "audio" else "text"
        self.voice_mem_class = voice_mem_class
        self.build_memory_context = build_memory_context
        self.instances: dict[str, object] = {}
        self.seen_path = state_dir / "observed-messages.json"
        self.observed_order: list[str] = []
        if self.seen_path.exists():
            self.observed_order.extend(json.loads(self.seen_path.read_text("utf-8")))
        self.observed_messages: set[str] = set(self.observed_order)

    def memory(self, owner_id: str):
        if owner_id not in self.instances:
            self.instances[owner_id] = self.voice_mem_class(
                user_id=owner_id,
                memory_root=str(self.root / owner_id),
                mode="multi_modal" if self.input_mode == "audio" else "text",
            )
        return self.instances[owner_id]

    def recall(self, params: dict) -> str:
        query = str(params.get("query", "")).strip()
        if not query:
            return ""
        memory = self.memory(str(params["ownerId"]))
        classification = memory.classify(query)
        result = memory.search(
            query,
            slots=classification.slots,
            entities=classification.entities,
            top_k=int(params.get("topK", 5)),
        )
        return self.build_memory_context(result)

    def observe(self, params: dict) -> dict:
        owner_id = str(params["ownerId"])
        unseen: list[tuple[str, str, Path | None]] = []
        for message in params.get("messages", []):
            if message.get("role") != "user":
                continue
            content = str(message.get("content", "")).strip()
            if not content:
                continue
            source_id = str(message.get("id", "")).strip()
            message_key = hashlib.sha256(
                f"{owner_id}\0{source_id or content}".encode("utf-8")
            ).hexdigest()
            if message_key in self.observed_messages:
                continue
            audio_path = Path(str(message.get("audioPath", "")))
            unseen.append((
                message_key,
                content,
                audio_path if self.input_mode == "audio" and audio_path.is_file() else None,
            ))
        if not unseen:
            return {"observed": False, "messages": 0}

        memory = self.memory(owner_id)
        session_id = str(params.get("sessionId", "")).strip() or None
        audio_messages = 0
        if self.input_mode == "audio":
            # Audio-backed voice turns use VoiceMem's native ingest(audio=...)
            # path, including its own ASR and acoustic perception. Typed turns
            # have no audio segment and intentionally fall back to text.
            for _, content, audio_path in unseen:
                if audio_path is not None:
                    memory.ingest(audio=str(audio_path), session_id=session_id)
                    audio_messages += 1
                else:
                    memory.ingest(content, session_id=session_id)
            batches = len(unseen)
        else:
            # One completed voice Session is one observation unit. Batching
            # avoids N sequential LLM extractions for N short turns and retains
            # context needed to resolve corrections within a Session.
            transcript = "\n".join(f"- {content}" for _, content, _ in unseen)
            memory.ingest(transcript, session_id=session_id)
            batches = 1
        for message_key, _, _ in unseen:
            self.observed_messages.add(message_key)
            self.observed_order.append(message_key)
        self.observed_order = self.observed_order[-20_000:]
        self.observed_messages = set(self.observed_order)
        temporary = self.seen_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.observed_order), encoding="utf-8")
        temporary.replace(self.seen_path)
        return {
            "observed": True,
            "messages": len(unseen),
            "audioMessages": audio_messages,
            "batches": batches,
            "inputMode": self.input_mode,
        }

    def flush(self, params: dict) -> dict:
        self.memory(str(params["ownerId"])).flush()
        return {"flushed": True}

    def close(self, _params: dict) -> dict:
        for memory in self.instances.values():
            memory.flush()
        return {"closed": True}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument(
        "--input-mode",
        choices=("text", "audio"),
        default="text",
    )
    args = parser.parse_args()
    voice_mem_class, build_memory_context = load_voicemem()
    runtime = Runtime(
        args.state_dir,
        voice_mem_class,
        build_memory_context,
        args.input_mode,
    )
    methods = {
        "recall": runtime.recall,
        "observe": runtime.observe,
        "flush": runtime.flush,
        "close": runtime.close,
    }
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            method = str(request.get("method", ""))
            if method not in methods:
                raise ValueError(f"unsupported method: {method}")
            result = methods[method](request.get("params") or {})
            response = {"id": request.get("id"), "result": result}
        except Exception as error:  # process boundary: return typed JSON failure
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": f"{type(error).__name__}: {error}",
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)
        if isinstance(request, dict) and request.get("method") == "close":
            break


if __name__ == "__main__":
    main()
