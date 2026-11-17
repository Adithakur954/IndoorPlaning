"""Exports a trained checkpoint to ONNX (dynamic height/width, multiples of 32) and checks it against PyTorch.

    train/.venv/Scripts/python.exe train/export_onnx.py --ckpt train/runs/run4/best.pt --out worker/models/floorplan_unet_v1.onnx
"""
import argparse
import os
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import evaluate as E  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, ck = E.load_model(args.ckpt, device)
    model = model.float().eval()
    dummy = torch.randn(1, 3, 512, 640, device=device)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    torch.onnx.export(model, dummy, args.out, input_names=["image"], output_names=["logits"],
                      dynamic_axes={"image": {2: "h", 3: "w"}, "logits": {2: "h", 3: "w"}},
                      opset_version=17, dynamo=False)
    print("exported", args.out, f"{os.path.getsize(args.out) / 1e6:.1f} MB", "step", ck["step"], "score", ck["score"])

    import onnxruntime as ort
    sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    worst = 0.0
    for h, w in ((512, 640), (384, 768), (1024, 1024)):
        x = torch.randn(1, 3, h, w)
        with torch.no_grad():
            ref = model(x.to(device)).cpu().numpy()
        got = sess.run(None, {"image": x.numpy()})[0]
        agree = float((ref.argmax(1) == got.argmax(1)).mean())
        worst = max(worst, float(np.abs(ref - got).max()))
        print(f"  {h}x{w}: label agreement PyTorch vs ONNX {agree * 100:.3f}%  max |logit diff| {np.abs(ref - got).max():.4f}")


if __name__ == "__main__":
    main()
