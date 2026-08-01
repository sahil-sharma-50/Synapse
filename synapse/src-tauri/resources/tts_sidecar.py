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

from pocket_tts import TTSModel
from pocket_tts.data.audio import stream_audio_chunks

_model = TTSModel.load_model()


def handle(request: dict) -> dict:
    try:
        text = request["text"]
        voice = request["voice"]
        out_path = request["out_path"]
        voice_state = _model.get_state_for_audio_prompt(voice)
        audio_chunks = _model.generate_audio_stream(
            model_state=voice_state, text_to_generate=text
        )
        stream_audio_chunks(out_path, audio_chunks, _model.sample_rate)
        return {"id": request["id"], "status": "ok"}
    except Exception as exc:  # noqa: BLE001 - any failure must produce a response line
        return {"id": request.get("id", 0), "status": "error", "message": str(exc)}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        response = handle(request)
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
