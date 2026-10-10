# Audio direction and provenance

/brag-style launch videos benefit from music and sparse cues, but this skill must distinguish **creative recommendation** from **authorization and file existence**.

- **Technical/data explainer:** default silent with legible captions when audio is unspecified. Offer optional licensed sound bed. Narration requires explicit owner opt-in; never infer voice preferences.
- **Launch/product film:** propose low-level background music and a few action-tied UI cues; **use audio only if an authorized local original/licensed source is available**, or explicitly approved generation can create one. No implicit stock download, external upload, service signup, TTS, or copied /brag music.
- Treat music and effects as one mix: no harsh peaks, do not stack clicks on every micro-movement. Synchronize only genuinely meaningful actions: type → click → tool executes → result arrives → end card.
- If the user requests a voiceover, lock speech script, language, voice and duration **before** final animation. Narration adds information rather than reading every on-screen word. Create caption transcripts.
- Original synthesis, licensed third-party track, and recorded narration have different rights. Record source path, creator/license, approved use and restrictions in `plan.md`. Any `--audio-credit` field is a human assertion, not a cryptographic validation of ownership.
- Check levels (true/peak level when tools allow), dialogue intelligibility, fades and sync; no clipping; audio duration covers the requested video or intentional shorter score ending. Mux via `scripts/package.mjs` for deterministic HTML mode after video passes QA. That helper does **not** generate audio.
- Avoid handing authoring secrets or internal product screenshots to external TTS/music/video vendors without explicit user permission. No built-in audio assets from /brag are bundled or copied here.
