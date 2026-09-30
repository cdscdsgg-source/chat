"""GROQ_API_KEY가 없을 때 subs.js가 호출하는 로컬 음성 인식 (faster-whisper, CPU).

사용법: python whisper_local.py <model> <chunk.ogg>...
stdout으로 한 줄에 JSON 하나씩 내보낸다:
  {"chunk": i, "start": s, "end": e, "text": "..."}  인식된 문장 (청크 기준 시간)
  {"chunk_done": i}                                  청크 하나 끝남
"""
import json
import os
import re
import sys

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from faster_whisper import BatchedInferencePipeline, WhisperModel  # noqa: E402


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def split_sentences(start, end, text):
    """배치 처리는 ~30초씩 묶어 내보내므로, 문장 단위로 나누고 시간은 글자 수 비율로 나눈다."""
    parts = [p.strip() for p in re.split(r"(?<=[.?!])\s+", text) if p.strip()]
    total = sum(len(p) for p in parts) or 1
    t = start
    for p in parts:
        dur = (end - start) * len(p) / total
        yield t, t + dur, p
        t += dur


def main():
    model_name, files = sys.argv[1], sys.argv[2:]
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    # 배치 처리 + 빔 1: 기본 설정(빔 5) 대비 약 2.8배 빠르고 품질 차이는 거의 없다 (Ryzen 5 4500U 기준 small 4.4배속)
    pipeline = BatchedInferencePipeline(model)
    for i, f in enumerate(files):
        segments, _ = pipeline.transcribe(f, batch_size=8, beam_size=1)
        for s in segments:
            for st, en, text in split_sentences(s.start, s.end, s.text.strip()):
                emit({"chunk": i, "start": round(st, 2), "end": round(en, 2), "text": text})
        emit({"chunk_done": i})


if __name__ == "__main__":
    main()
