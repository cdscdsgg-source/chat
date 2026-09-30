"""GROQ_API_KEY가 없을 때 subs.js가 호출하는 로컬 음성 인식 (faster-whisper, CPU).

사용법: python whisper_local.py <model> <chunk.ogg>...
stdout으로 한 줄에 JSON 하나씩 내보낸다:
  {"chunk": i, "start": s, "end": e, "text": "..."}  인식된 문장 (청크 기준 시간)
  {"chunk_done": i}                                  청크 하나 끝남
"""
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from faster_whisper import WhisperModel  # noqa: E402


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model_name, files = sys.argv[1], sys.argv[2:]
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    for i, f in enumerate(files):
        segments, _ = model.transcribe(f, vad_filter=True)
        for s in segments:
            text = s.text.strip()
            if text:
                emit({"chunk": i, "start": s.start, "end": s.end, "text": text})
        emit({"chunk_done": i})


if __name__ == "__main__":
    main()
