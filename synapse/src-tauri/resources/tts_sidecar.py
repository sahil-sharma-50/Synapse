"""Long-lived TTS worker spawned by Synapse. Reads one JSON request per line
from stdin, synthesizes speech with pocket-tts, writes a WAV file to the
requested path, and writes one JSON response per line to stdout. Loads the
model once at startup so repeated requests don't pay model-load cost again.

Voice names (e.g. "alba", "giovanni", "lola", "juergen", "rafael", "estelle")
are passed straight through to pocket_tts's TTSModel.get_state_for_audio_prompt,
which resolves built-in shorthand names to their hf:// weights internally
(see pocket_tts.utils.utils._ORIGINS_OF_PREDEFINED_VOICES) -- this script does
not need to do that mapping itself.
"""
import json
import sys
import wave
from pathlib import Path

from pocket_tts import TTSModel

_model = TTSModel.load_model()
_voice_states = {}
for _voice in ("alba", "giovanni", "lola", "juergen", "rafael", "estelle"):
    try:
        _voice_states[_voice] = _model.get_state_for_audio_prompt(_voice)
    except Exception as exc:  # individual voices can retry when selected
        print(f"Voice warm-up failed for {_voice}: {exc}", file=sys.stderr, flush=True)


def _write_audio_chunk(base_path: str, index: int, audio_chunk) -> str:
    base = Path(base_path)
    chunk_path = base.with_name(f"{base.stem}-{index}{base.suffix}")
    chunk_int16 = (audio_chunk.clamp(-1, 1) * 32767).short()
    chunk_bytes = chunk_int16.detach().cpu().numpy().tobytes()
    with wave.open(str(chunk_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(_model.sample_rate)
        output.writeframes(chunk_bytes)
    return str(chunk_path)


def handle(request: dict) -> dict:
    try:
        text = request["text"]
        voice = request["voice"]
        out_path = request["out_path"]
        voice_state = _voice_states.get(voice)
        if voice_state is None:
            voice_state = _model.get_state_for_audio_prompt(voice)
            _voice_states[voice] = voice_state
        audio_chunks = _model.generate_audio_stream(
            model_state=voice_state, text_to_generate=text
        )
        for index, audio_chunk in enumerate(audio_chunks):
            chunk_path = _write_audio_chunk(out_path, index, audio_chunk)
            print(
                json.dumps(
                    {"id": request["id"], "status": "chunk", "path": chunk_path}
                ),
                flush=True,
            )
        return {"id": request["id"], "status": "ok"}
    except Exception as exc:  # noqa: BLE001 - any failure must produce a response line
        return {"id": request.get("id", 0), "status": "error", "message": str(exc)}


def main() -> None:
    print(json.dumps({"id": 0, "status": "ready"}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle(request)
        except Exception as exc:  # noqa: BLE001 - any failure must produce a response line
            # Safely extract the request ID from the line for the error response.
            # This must not crash even if:
            # - The line is malformed JSON
            # - The JSON parses but isn't a dict (e.g. list, string, number)
            request_id = 0
            try:
                parsed = json.loads(line)
                request_id = parsed.get("id", 0) if isinstance(parsed, dict) else 0
            except Exception:
                pass
            response = {"id": request_id, "status": "error", "message": str(exc)}
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
