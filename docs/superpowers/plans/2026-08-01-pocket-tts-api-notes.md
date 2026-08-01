# pocket-tts / python-build-standalone integration notes

Verified by installing `pocket-tts` (v2.1.0, from PyPI) into a real venv on this
machine (`python -m venv`, `pip install pocket-tts`) and running
`python -c "import pocket_tts; help(pocket_tts)"` plus `inspect.getsource(...)`
against the installed package. Model *weights* were not downloaded/generated
end-to-end (they are gigabytes and fetched lazily from Hugging Face on first
`load_model()`/`get_state_for_audio_prompt()` call) — everything below the line
"Verified by execution" vs "Inferred from source" is called out explicitly.

## pocket-tts Python API

- Import: `from pocket_tts import TTSModel`

- Load once (reusable across multiple `generate_audio`/`generate_audio_stream`
  calls, no reload needed):
  ```python
  model = TTSModel.load_model(
      language: str | None = None,   # e.g. "english" (default), "french_24l", "german_24l", "portuguese", "italian", "spanish_24l", "english_2026-01", "english_2026-04"
      config: str | None = None,     # path to a custom YAML config; mutually exclusive with language
      temp: float = ...,             # sampling temperature (DEFAULT_TEMPERATURE)
      lsd_decode_steps: int = ...,
      noise_clamp: float | None = ...,
      eos_threshold: float = ...,
      quantize: bool = False,        # int8 dynamic quantization; ~48% less RAM, ~27% faster on x86; needs `pip install pocket-tts[quantize]` (torchao) for the speed win
  ) -> TTSModel
  ```
  `TTSModel.load_model` is a classmethod. It returns a model loaded on CPU by
  default (call `model.to(device)` to move it, e.g. `"cuda"`). It is a
  `torch.nn.Module` subclass.

- Voice conditioning state (needed before synthesis, and itself reusable/cacheable):
  ```python
  voice_state = model.get_state_for_audio_prompt(
      audio_conditioning: Path | str | torch.Tensor,  # local file path, hf://... or http(s):// URL, built-in voice name, or a pre-loaded tensor [channels, samples]
      truncate: bool = False,   # truncate long prompts to 30s
  ) -> dict
  ```
  Built-in voice shorthand names seen in the CLI defaults: `alba` (default for
  most languages), `giovanni` (italian), `lola` (spanish), `juergen` (german),
  `rafael` (portuguese), `estelle` (french). Full example from the docstring:
  `model.get_state_for_audio_prompt("hf://kyutai/tts-voices/alba-mackenna/casual.wav")`.
  A `.safetensors` path can also be passed to reload a previously-exported
  state faster than re-extracting from raw audio.

- Synthesize (blocking, whole utterance at once):
  ```python
  audio: torch.Tensor = model.generate_audio(
      model_state: dict,            # from get_state_for_audio_prompt() (or init_states())
      text_to_generate: str,
      max_tokens: int = 50,
      frames_after_eos: int | None = None,
      copy_state: bool = True,      # True = don't mutate/consume the passed-in state, so it can be reused for the next call
  ) -> torch.Tensor   # shape [channels, samples], at model.sample_rate (typically 24kHz), normalized float
  ```
  Not thread-safe — use a separate `TTSModel` instance per concurrent
  generation.

- Synthesize (streaming, chunk-by-chunk, for lower latency to first audio):
  ```python
  for chunk in model.generate_audio_stream(
      model_state: dict,
      text_to_generate: str,
      max_tokens: int = 50,
      frames_after_eos: int | None = None,
      copy_state: bool = True,
  ):
      # chunk: torch.Tensor, shape [samples], at model.sample_rate
      ...
  ```

- Sample rate / device:
  ```python
  model.sample_rate   # readonly property, int, e.g. 24000
  model.device         # readonly property
  ```

- How to get WAV bytes/samples from the return value:
  There is no public one-call "generate and write WAV" method on `TTSModel`
  itself; the CLI (`pocket_tts/main.py`, `generate` command) does it in two
  steps using an internal helper:
  ```python
  from pocket_tts.data.audio import stream_audio_chunks

  audio_chunks = model.generate_audio_stream(model_state=voice_state, text_to_generate=text)
  stream_audio_chunks(output_path, audio_chunks, model.sample_rate)  # writes a WAV file directly (path, "-" for stdout, or a file-like object)
  ```
  `stream_audio_chunks` (in `pocket_tts.data.audio`) accepts a path (or `-`
  for stdout, or an already-open file-like object) plus an iterator of
  `torch.Tensor` chunks and a sample rate, and streams them into a WAV file
  via the internal `StreamingWAVWriter` class, which wraps Python's built-in
  `wave` module: mono, 16-bit PCM, `sample_rate = model.sample_rate`. The
  conversion from float tensor to PCM bytes it performs is:
  ```python
  chunk_int16 = (audio_chunk.clamp(-1, 1) * 32767).short()
  chunk_bytes = chunk_int16.detach().cpu().numpy().tobytes()
  ```
  So for a single `generate_audio()` tensor (non-streaming path), the same
  conversion can be applied manually and written with `wave.open(path, "wb")`
  (`setnchannels(1)`, `setsampwidth(2)`, `setframerate(model.sample_rate)`),
  or the whole tensor can be wrapped in a one-item iterator and passed to
  `stream_audio_chunks` directly — this is the simplest path and matches
  exactly what the shipped CLI does.

  Note `pocket_tts.data.audio` is not documented as public API (no `__all__`
  export from the top-level `pocket_tts` package points at it — only
  `TTSModel` is re-exported at the package root per `help(pocket_tts)`), so
  importing `pocket_tts.data.audio.stream_audio_chunks` directly is an
  internal-module dependency, not a stable public contract. It has been
  stable/present in this installed version (2.1.0) and is what the shipped
  CLI itself relies on.

- Verified by execution: package installs cleanly via `pip install pocket-tts`
  (pulls in `torch`, `torchaudio`-adjacent deps are NOT required — audio I/O
  uses the stdlib `wave` module for WAV — plus `fastapi`/`uvicorn`/`typer` for
  the bundled CLI/server, `huggingface-hub`, `safetensors`, `sentencepiece`,
  `scipy`, `numpy`); `from pocket_tts import TTSModel` and `help(pocket_tts)`
  ran successfully; `inspect.getsource()` on `pocket_tts.main` and
  `pocket_tts.data.audio` confirmed the above signatures and the WAV-writing
  code path.
- Inferred (not executed): actual model download + `generate_audio()` output
  was not run end-to-end in this spike — `load_model()`/
  `get_state_for_audio_prompt()` fetch multi-GB weights from Hugging Face on
  first use, which was out of scope for this research task. Return shapes,
  docstring examples, and the CLI's own WAV-writing code path (all read from
  source) are consistent with each other and are the basis for the notes
  above.

## python-build-standalone

- Release tag: `20260728` (queried via `gh api repos/astral-sh/python-build-standalone/releases/tags/20260728` — this is what `https://github.com/astral-sh/python-build-standalone/releases/latest` currently redirects to; the JSON asset listing was fetched directly since the GitHub releases HTML page lazy-loads its (800+) asset list client-side and does not render it in a plain fetch).
- Windows asset filename (non-freethreaded, non-stripped, `install_only` — the redistributable build with pip already included): `cpython-3.12.13+20260728-x86_64-pc-windows-msvc-install_only.tar.gz`
- Windows asset URL:
  `https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.12.13+20260728-x86_64-pc-windows-msvc-install_only.tar.gz`
- Other Windows `install_only` variants available in the same release, in case a different CPython minor is preferred later: 3.10.20, 3.11.15, 3.12.13, 3.13.14 (also has a `-freethreaded-` variant), 3.14.6 (also `-freethreaded-`), 3.15.0b4 (also `-freethreaded-`) — all under the same `20260728` tag, same URL pattern with the version substituted.
- Archive layout (where python.exe / pip live after extraction) — **verified
  by actually downloading the 3.12.13 archive above (46,148,055 bytes) and
  listing its contents with `tar -tzf`**:
  - The tarball extracts to a top-level `python/` directory (i.e. the archive
    root is `python/...`, not `.`/flat).
  - `python/python.exe` and `python/pythonw.exe` are the interpreters.
  - There is **no `python/Scripts/pip.exe`** — `python/Scripts/` exists but
    only contains a placeholder `.empty` file. Pip is present as a *library*
    (`python/Lib/site-packages/pip-26.1.2.dist-info/...` — a fully
    pre-installed pip, not just the `ensurepip` bundled wheel) but has no
    console-script `.exe` shim generated for it in this build.
  - Practical consequence for later tasks: invoke pip via
    `python\python.exe -m pip install ...`, not `python\Scripts\pip.exe`,
    when driving this extracted interpreter directly. (`python -m venv` from
    this interpreter, by contrast, *does* generate a working
    `Scripts\pip.exe` inside the venv it creates, same as any other CPython
    — this was confirmed separately in this spike by creating the venv used
    for the pocket-tts install above, which has both `Scripts\pip.exe` and
    `Scripts\python.exe`.)
  - Also present: `python/Lib/` (stdlib), `python/DLLs/` (extension modules),
    `python/LICENSE.txt`, `python3.dll`/`python312.dll`, `vcruntime140*.dll`.
