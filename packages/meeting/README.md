# meeting/ — meeting capture and minutes

English | [中文](README.zh.md)

Optional browser and Host plugins that capture meeting audio, transcribe it, and either publish durable meeting artifacts or assist a live call.

| Package | Role | ctx key |
|---|---|---|
| [`meeting-minutes/`](meeting-minutes/README.md) | Browser recorder, Host audio normalization, Qwen ASR, LLM summary, and Markdown download | registers Web routes and a Client slot |
| [`live-assist/`](live-assist/README.md) | Counterpart-only tab-audio capture, silero-vad segmentation, live Qwen ASR, and streamed answer suggestions | registers a Web upgrade route and a Client slot |
