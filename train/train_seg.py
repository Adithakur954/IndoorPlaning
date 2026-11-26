"""Trains the floor-plan segmentation U-Net from scratch (no pretrained weights, so it is commercially clean).

    train/.venv/Scripts/python.exe train/train_seg.py --data train/dataset_v3 --out train/runs/run1
    train/.venv/Scripts/python.exe train/train_seg.py --smoke          # ~200 steps: speed / memory / sanity check only

Classes: 0 background, 1 wall, 2 door, 3 window, 4 floor, 5 column, ... (14 with --data; 16 with --mix, which adds
14 stairs and 15 void).

Run 6 (dataset v6 mix, see train/README.md "Dataset v6"):
    train/.venv/Scripts/python.exe train/train_seg.py --mix train/mix_v6.json --preset A --short --out train/runs/run6_A
    ... --preset B (+ Skeleton Recall Loss)   ... --preset C (+ Skeleton Recall Loss + wall centre-line head)
    train/.venv/Scripts/python.exe train/train_seg.py --mix train/mix_v6.json --preset C --dry-run    # no training
With --mix the best model is chosen by the structure score of metrics_v6.py (rooms that close, walls that connect,
junctions, few false walls, doors found) on the v6 validation images, unless --select key.

Training is step based.  Every --eval-every steps the model is scored on the validation set; the score is the
mean IoU of the thin classes (wall, door, window, column).  The learning rate is halved after --lr-patience
evaluations without improvement and training stops after --patience evaluations in a row that improve the score by
less than --min-delta (after --min-steps).  best.pt always holds the best model, so stopping early loses nothing.
"""
import argparse
import glob
import json
import math
import os
import random
import sys
import time

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rescale  # noqa: E402
import damage_v6  # noqa: E402

CLASSES = ["background", "wall", "door", "window", "floor", "column", "ap",
           "desk", "chair", "table", "sofa", "plant", "pod", "storage"]
CLASSES_V6 = CLASSES + ["stairs", "void"]
STRUCT = [1, 2, 3, 5]  # wall, door, window, column: what a wall centre-line must lie on
KEY = [1, 2, 3, 5, 7, 8, 11]  # thin structure + desks/tables, chairs and plants decide the score
IGNORE = 255
# Look-alike classes are merged when a mask is loaded (the files on disk stay as generated): a long bench is "desk"
# whether the generator called it desk or table, and the sofa symbol looks like a plain desk, so it is not judged.
_LUT = np.arange(256, dtype=np.uint8)
_LUT[9] = 7
_LUT[10] = IGNORE
cv2.setNumThreads(1)


def list_split(root, split):
    ext = {os.path.splitext(f)[0]: f for f in os.listdir(os.path.join(root, split, "images"))}
    items = []
    for f in sorted(os.listdir(os.path.join(root, split, "meta"))):
        name = f[:-5]
        if name in ext:
            items.append((os.path.join(root, split, "images", ext[name]),
                          os.path.join(root, split, "masks", name + ".png"), os.path.join(root, split, "meta", f)))
    return items


class PlanData(Dataset):
    """Random rescale (0.3-1.5x), rotate/flip, colour jitter, then a crop; the mask follows the image."""

    def __init__(self, items, crop=1024, train=True, steps=1, manifest=None):
        self.items, self.crop, self.train, self.steps = items, crop, train, steps
        self.manifest = manifest   # a mix_v6 manifest: images drawn by source share, centre-lines returned too
        self.sampler = None

    def __len__(self):
        return self.steps if self.train else len(self.items)

    def __getitem__(self, i):
        if not self.train:
            return self.load(self.items[i])
        rng = random.Random((i * 2654435761) ^ int.from_bytes(os.urandom(4), "little"))
        lines = None
        if self.manifest is not None:
            import mix_v6
            if self.sampler is None:
                self.sampler = mix_v6.MixSampler(self.items, self.manifest)
            img, mask, lines = mix_v6.load(self.sampler(rng), rng, np.random.default_rng(rng.randrange(1 << 30)),
                                           self.manifest)
            mask = _LUT[mask]
            lines = np.where(mask == 1, lines, 0).astype(np.uint8)
        else:
            img, mask = self.load(self.items[rng.randrange(len(self.items))])
        f = math.exp(rng.uniform(math.log(0.3), math.log(1.5)))
        if max(img.shape[:2]) * f < 256:
            f = 256 / max(img.shape[:2])
        if f < 0.98:
            if lines is None:
                img, mask = rescale.shrink(img, mask, f)
            else:
                img, mask, lines = damage_v6.shrink(img, mask, lines, f)
        elif f > 1.02:
            img, mask = rescale.enlarge(img, mask, f)
            if lines is not None:
                lines = cv2.resize(lines, (mask.shape[1], mask.shape[0]), interpolation=cv2.INTER_NEAREST)
                if f > 1.6:
                    lines = _thin(lines)
                lines[mask != 1] = 0
        k = rng.randrange(4)
        img, mask = np.rot90(img, k), np.rot90(mask, k)
        if lines is not None:
            lines = np.rot90(lines, k)
        if rng.random() < 0.5:
            img, mask = img[:, ::-1], mask[:, ::-1]
            if lines is not None:
                lines = lines[:, ::-1]
        img, mask, lines = self.crop_pair(np.ascontiguousarray(img), np.ascontiguousarray(mask), rng,
                                          None if lines is None else np.ascontiguousarray(lines))
        img = img.astype(np.float32)
        if rng.random() < 0.8:
            img = img * rng.uniform(0.75, 1.25) + rng.uniform(-25, 25)
        if rng.random() < 0.1:
            img[:] = img.mean(axis=2, keepdims=True)
        x = torch.from_numpy(np.clip(img, 0, 255) / 127.5 - 1.0).permute(2, 0, 1).contiguous()
        y = torch.from_numpy(mask.astype(np.int64))
        if self.manifest is None:
            return x, y
        return x, y, torch.from_numpy((lines > 0).astype(np.float32))

    @staticmethod
    def load(item):
        img = cv2.imread(item[0], cv2.IMREAD_COLOR)
        mask = _LUT[cv2.imread(item[1], cv2.IMREAD_GRAYSCALE)]
        return img, mask

    def crop_pair(self, img, mask, rng, lines=None):
        c = self.crop
        h, w = mask.shape
        ph, pw = max(0, c - h), max(0, c - w)
        if ph or pw:  # pad: plain background for the image, 'ignore' for the mask
            img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=(255, 255, 255))
            mask = cv2.copyMakeBorder(mask, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=IGNORE)
            if lines is not None:
                lines = cv2.copyMakeBorder(lines, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=0)
            h, w = mask.shape
        best, best_n = None, -1
        for _ in range(3):  # of 3 random crops keep the one with most door/window/column pixels
            y, x = rng.randint(0, h - c), rng.randint(0, w - c)
            m = mask[y:y + c, x:x + c]
            n = int(np.isin(m, (2, 3, 5)).sum())
            if n > best_n:
                best, best_n = (y, x), n
        y, x = best
        return img[y:y + c, x:x + c], mask[y:y + c, x:x + c], (None if lines is None else lines[y:y + c, x:x + c])


def to_tensor(img):
    return torch.from_numpy(img.astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1)[None]


def _thin(lines):
    from skimage.morphology import skeletonize
    return (skeletonize(lines > 0) * 255).astype(np.uint8)


@torch.no_grad()
def predict(model, img, device, n_classes=None):
    """Full-image prediction; the image is padded to a multiple of 32 and the result cropped back."""
    h, w = img.shape[:2]
    ph, pw = (-h) % 32, (-w) % 32
    if ph or pw:
        img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_REPLICATE)
    x = to_tensor(img).to(device).contiguous(memory_format=torch.channels_last)
    with torch.autocast(device.type, dtype=torch.bfloat16):
        out = model(x)
    n_classes = n_classes or getattr(model, "n_classes", None)
    if n_classes is not None:
        out = out[:, :n_classes]   # a centre-line channel, if there is one, is not a class
    return out.argmax(1)[0, :h, :w].to(torch.uint8).cpu().numpy()


def confusion(pred, mask, n=len(CLASSES)):
    pred = np.minimum(pred, n - 1)
    ok = mask != IGNORE            # pixels the generator does not label (home furniture)
    return np.bincount(mask[ok].astype(np.int64) * n + pred[ok], minlength=n * n).reshape(n, n)


def evaluate_topo(model, items, device, limit=40, n_classes=len(CLASSES_V6)):
    """Structure metrics (metrics_v6.py) on v6 validation images: the number run 6 is chosen by."""
    import metrics_v6 as M
    import mix_v6
    model.eval()
    torch.backends.cudnn.benchmark = False
    agg = M.Aggregate()
    for it in items[:limit]:
        img, mask, lines = mix_v6.load(it)
        meta = json.load(open(it[2]))
        agg.add(M.plan_metrics(predict(model, img, device, n_classes), _LUT[mask], lines, meta.get("px_per_m")))
    model.train()
    torch.backends.cudnn.benchmark = True
    r = agg.result()
    r["topo_score"] = M.topo_score(r)
    return r


def scores(cm):
    tp = np.diag(cm).astype(float)
    fp, fn = cm.sum(0) - tp, cm.sum(1) - tp
    with np.errstate(divide="ignore", invalid="ignore"):
        iou, prec, rec = tp / (tp + fp + fn), tp / (tp + fp), tp / (tp + fn)
        f1 = 2 * prec * rec / (prec + rec)
    return dict(iou=iou, precision=prec, recall=rec, f1=f1, miou=float(np.nanmean(iou)),
                key=float(np.nanmean(iou[[k for k in KEY if k < len(iou)]])))


def evaluate(model, items, device, limit=None, n_classes=len(CLASSES)):
    model.eval()
    torch.backends.cudnn.benchmark = False  # every image has a different size
    cm = np.zeros((n_classes,) * 2, np.int64)
    for it in items[:limit]:
        img, mask = PlanData.load(it)
        cm += confusion(predict(model, img, device, n_classes), mask, n_classes)
    model.train()
    torch.backends.cudnn.benchmark = True
    return scores(cm), cm


REAL = os.path.join(HERE, "real_check")


def real_check(model, device):
    """Never trained on: how much of the traced wall lines of a real coworking plan the model marks as
    structure (wall/door/window/column/AP), and how many Wi-Fi markers it finds. Shown next to the synthetic
    score so a drift away from real plans is visible within minutes. Not used to pick the best model."""
    path = os.path.join(REAL, "coworking1.jpeg")
    if not os.path.exists(path):
        return None
    spec = json.load(open(os.path.join(REAL, "lines.json")))
    img = cv2.imread(path)
    torch.backends.cudnn.benchmark = False
    model.eval()
    pred = predict(model, img, device)
    model.train()
    torch.backends.cudnn.benchmark = True
    mask = cv2.dilate(np.isin(pred, [1, 2, 3, 5, 6]).astype(np.uint8), np.ones((17, 17), np.uint8))
    cov = {}
    for name, (x1, y1, x2, y2) in spec["lines"].items():
        n = int(max(abs(x2 - x1), abs(y2 - y1)))
        xs = np.round(np.linspace(x1, x2, n + 1)).astype(int)
        ys = np.round(np.linspace(y1, y2, n + 1)).astype(int)
        cov[name] = round(100.0 * float(mask[ys, xs].mean()), 1)
    blobs, _, st, _ = cv2.connectedComponentsWithStats((pred == 6).astype(np.uint8), connectivity=8)[0:4]
    n_ap = int((st[1:, cv2.CC_STAT_AREA] >= 150).sum())
    out = dict(lines=cov, line_mean=round(float(np.mean(list(cov.values()))), 1), ap_found=n_ap,
               ap_expected=spec["ap_expected"])
    path2 = os.path.join(REAL, "coworking2.png")
    if os.path.exists(path2):
        torch.backends.cudnn.benchmark = False
        model.eval()
        pred2 = predict(model, cv2.imread(path2), device)
        model.train()
        torch.backends.cudnn.benchmark = True
        found = {}
        for nm, cl in (("chair", 8), ("desk", 7), ("plant", 11), ("pod", 12), ("storage", 13)):
            n_i, _, st_i, _ = cv2.connectedComponentsWithStats((pred2 == cl).astype(np.uint8), connectivity=8)[0:4]
            found[nm] = int((st_i[1:, cv2.CC_STAT_AREA] >= 25).sum())
        out["plan2_found"] = found
    return out


def class_weights(root, classes=CLASSES, manifest=None):
    """Inverse-sqrt class frequency. For a mix each source counts by its share (mean pixels per image x share)."""
    tot = np.zeros(len(classes))
    sources = [(root, 1.0)] if manifest is None else [(s["path"], s["share"]) for s in manifest["sources"]]
    for path, share in sources:
        part, n = np.zeros(len(classes)), 0
        for m in glob.glob(os.path.join(path, "train", "meta", "*.json")):
            with open(m) as f:
                d = json.load(f)["class_pixels"]
            part += np.array([d.get(c, 0) for c in classes], float)
            n += 1
        if n:
            tot += share * part / n
    tot[7] += tot[9]
    tot[9] = 0      # table merged into desk
    tot[10] = 0     # sofa is ignored
    share = np.maximum(tot / tot.sum(), 1e-7)
    w = 1.0 / np.sqrt(share)
    w = np.clip(w / w[0], 1.0, 12.0)  # background = 1, rare classes more
    return share, w


def make_model(encoder, n=len(CLASSES)):
    import segmentation_models_pytorch as smp
    return smp.Unet(encoder, encoder_weights=None, in_channels=3, classes=n)


class ClassLogits(torch.nn.Module):
    """Wraps a model that has a centre-line channel so it returns class scores only (export, worker)."""

    def __init__(self, model, n):
        super().__init__()
        self.model, self.n_classes = model, n

    def forward(self, x):
        return self.model(x)[:, :self.n_classes]


def skeleton_recall_loss(probs, lines, valid):
    """Skeleton Recall Loss (Kirchhoff et al., 2024): the true wall centre-line must be covered by predicted
    structure (wall / door / window / column). Cheap, multi-class friendly, and it punishes broken walls."""
    p = probs[:, STRUCT].sum(1)
    sk = lines * valid
    return 1.0 - (p * sk).sum() / (sk.sum() + 1.0)


def centreline_loss(logit, lines, valid):
    """BCE (centre-lines are sparse, so positives weigh more) + soft Dice on the centre-line channel."""
    bce = F.binary_cross_entropy_with_logits(logit, lines, pos_weight=torch.tensor(8.0, device=logit.device),
                                             reduction="none")
    bce = (bce * valid).sum() / (valid.sum() + 1.0)
    p = torch.sigmoid(logit) * valid
    dice = 1 - (2 * (p * lines).sum() + 1) / (p.sum() + (lines * valid).sum() + 1)
    return bce + dice


def loss_fn(logits, target, weight, n=len(CLASSES), lines=None, skel_w=0.0, line_w=0.0):
    """Cross entropy + Dice over the classes (as in run 1-5); optionally + Skeleton Recall Loss and the
    centre-line head. Returns (total, parts)."""
    cls = logits[:, :n]
    ce = F.cross_entropy(cls, target, weight=weight, ignore_index=IGNORE)
    valid = (target != IGNORE)
    p = cls.float().softmax(1)
    t = F.one_hot(target.clamp(max=n - 1), n).permute(0, 3, 1, 2).float()
    v = valid[:, None].float()
    inter, den = (p * t * v).sum((0, 2, 3)), ((p + t) * v).sum((0, 2, 3))
    dice = 1 - ((2 * inter + 1) / (den + 1))[1:].mean()  # background left to CE
    total, parts = ce + dice, {"ce": float(ce), "dice": float(dice)}
    if lines is not None and skel_w > 0:
        sk = skeleton_recall_loss(p, lines, valid.float())
        total = total + skel_w * sk
        parts["skel"] = float(sk)
    if lines is not None and line_w > 0 and logits.shape[1] > n:
        cl = centreline_loss(logits[:, n].float(), lines, valid.float())
        total = total + line_w * cl
        parts["line"] = float(cl)
    return total, parts


def fmt_t(s):
    s = int(max(0, s))
    return f"{s // 3600}h{s % 3600 // 60:02d}m"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "dataset_v3"))
    ap.add_argument("--out", default=os.path.join(HERE, "runs", "run1"))
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--crop", type=int, default=1024)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--max-steps", type=int, default=200000)
    ap.add_argument("--min-steps", type=int, default=6000)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--eval-images", type=int, default=250, help="validation images per check (0 = all)")
    ap.add_argument("--patience", type=int, default=5, help="stop after this many evals without a gain of min-delta")
    ap.add_argument("--min-delta", type=float, default=1e-4)
    ap.add_argument("--lr-patience", type=int, default=2, help="halve the lr after this many flat evals")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--init", help="start from the weights of this checkpoint (fine-tuning), with a fresh optimiser")
    ap.add_argument("--smoke", action="store_true", help="short speed/sanity run, nothing kept")
    # ---- run 6
    ap.add_argument("--mix", help="mix manifest (train/mix_v6.json): old + new data by share, 16 classes, centre-lines")
    ap.add_argument("--preset", choices=["A", "B", "C"],
                    help="A: CE+Dice  B: + Skeleton Recall Loss  C: + Skeleton Recall Loss + centre-line head")
    ap.add_argument("--skel-weight", type=float, default=0.0, help="weight of the Skeleton Recall Loss")
    ap.add_argument("--line-head", action="store_true", help="add a wall centre-line output channel")
    ap.add_argument("--line-weight", type=float, default=0.5)
    ap.add_argument("--select", choices=["key", "topo"], help="model selection score (default: topo with --mix)")
    ap.add_argument("--topo-images", type=int, default=40, help="v6 validation images for the structure score")
    ap.add_argument("--short", action="store_true", help="short comparison run: 12,000 steps, same budget for A/B/C")
    ap.add_argument("--dry-run", action="store_true", help="build everything, one forward pass + loss + scores, no training")
    args = ap.parse_args()
    if args.preset in ("B", "C") and args.skel_weight == 0:
        args.skel_weight = 1.0
    if args.preset == "C":
        args.line_head = True
    args.select = args.select or ("topo" if args.mix else "key")
    if args.short:
        args.max_steps, args.min_steps, args.patience = 12000, 12000, 10 ** 6
    if args.smoke:
        args.out = os.path.join(HERE, "runs", "smoke")
        args.max_steps, args.eval_every, args.eval_images, args.min_steps = 200, 100, 20, 0
    os.makedirs(args.out, exist_ok=True)

    device = torch.device("cuda")
    torch.backends.cudnn.benchmark = True
    manifest, topo_items = None, []
    if args.mix:
        import mix_v6
        manifest = mix_v6.read_manifest(args.mix)
        classes = CLASSES_V6
        train_items = mix_v6.list_mix(manifest, "train")
        val_all = mix_v6.list_mix(manifest, "val")
        val_items = [it[:3] for it in val_all]
        topo_items = [it for it in val_all if it[3] is not None]     # v6 images (they have centre-line files)
        random.Random(1).shuffle(topo_items)
        per = {}
        for it in train_items:
            per[manifest["sources"][it[4]]["root"]] = per.get(manifest["sources"][it[4]]["root"], 0) + 1
        print("mix:", {s["root"]: f"{100 * s['share']:.0f} %" for s in manifest["sources"]}, " train images", per)
    else:
        classes = CLASSES
        train_items, val_items = list_split(args.data, "train"), list_split(args.data, "val")
    n_cls = len(classes)
    random.Random(0).shuffle(val_items)  # fixed random subset, mixed sources
    print(f"train {len(train_items)}  val {len(val_items)}  crop {args.crop}  batch {args.batch}  classes {n_cls}  "
          f"skeleton-loss {args.skel_weight}  centre-line head {args.line_head}  select by {args.select}")
    share, w = class_weights(args.data, classes, manifest)
    print("class share %:", {c: round(100 * s, 2) for c, s in zip(classes, share)})
    print("class weights :", {c: round(float(x), 2) for c, x in zip(classes, w)})
    weight = torch.tensor(w, dtype=torch.float32, device=device)

    model = make_model(args.encoder, n_cls + (1 if args.line_head else 0)).to(device).to(memory_format=torch.channels_last)
    model.n_classes = n_cls
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location=device)["model"])
        print(f"initialised from {args.init}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    state = dict(step=0, best=-1.0, flat=0, since_gain=0, lr=args.lr)
    ck = os.path.join(args.out, "last.pt")
    if args.resume and os.path.exists(ck):
        s = torch.load(ck, map_location=device)
        model.load_state_dict(s["model"]); opt.load_state_dict(s["opt"]); state = s["state"]
        print(f"resumed at step {state['step']}")

    steps_left = args.max_steps - state["step"]
    loader = DataLoader(PlanData(train_items, args.crop, True, max(steps_left, 2) * args.batch, manifest), batch_size=args.batch,
                        num_workers=args.workers, persistent_workers=True, prefetch_factor=4, pin_memory=True)
    if args.dry_run:
        batch = next(iter(loader))
        x, y = batch[0].to(device), batch[1].to(device)
        lines = batch[2].to(device) if len(batch) > 2 else None
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(x.contiguous(memory_format=torch.channels_last))
        loss, parts = loss_fn(logits.float(), y, weight, n_cls, lines, args.skel_weight, args.line_weight if args.line_head else 0)
        print(f"dry run: batch {tuple(x.shape)}  logits {tuple(logits.shape)}  loss {float(loss):.3f}  parts {parts}  "
              f"centre-line px in batch {int(lines.sum()) if lines is not None else 0}")
        sc, _ = evaluate(model, val_items, device, 3, n_cls)
        print(f"dry run: pixel scores work (key IoU {sc['key']:.3f} for an untrained model)")
        if args.select == "topo":
            tr = evaluate_topo(model, topo_items, device, 3, n_cls)
            print(f"dry run: structure score works (topo {tr['topo_score']:.3f}, room closure {tr['room_closure_bridged']})")
        print("dry run done: nothing trained, nothing saved")
        return
    from tqdm import tqdm
    log = open(os.path.join(args.out, "log.jsonl"), "a")
    bar = tqdm(total=args.max_steps, initial=state["step"], unit="step", dynamic_ncols=True,
               bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}] {postfix}")
    t0, run_loss, n_loss, step0 = time.time(), 0.0, 0, state["step"]
    model.train()
    stop = None
    for batch in loader:
        x, y = batch[0], batch[1]
        lines = batch[2].to(device, non_blocking=True) if len(batch) > 2 else None
        step = state["step"] + 1
        warm = min(1.0, step / 500)
        for g in opt.param_groups:
            g["lr"] = state["lr"] * warm
        x = x.to(device, non_blocking=True).contiguous(memory_format=torch.channels_last)
        y = y.to(device, non_blocking=True)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(x)
        loss, _parts = loss_fn(logits.float(), y, weight, n_cls, lines, args.skel_weight,
                               args.line_weight if args.line_head else 0.0)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        opt.step()
        state["step"] = step
        run_loss += loss.item(); n_loss += 1
        bar.update(1)
        if step % 20 == 0:
            bar.set_postfix(loss=f"{run_loss / n_loss:.3f}", lr=f"{state['lr']:.1e}", best=f"{max(state['best'], 0):.4f}",
                            flat=f"{state['since_gain']}/{args.patience}", refresh=True)
        if step % args.eval_every == 0 or step >= args.max_steps:
            sc, _ = evaluate(model, val_items, device, args.eval_images or None, n_cls)
            rc = real_check(model, device)
            tr = evaluate_topo(model, topo_items, device, args.topo_images, n_cls) if topo_items else None
            score = tr["topo_score"] if (args.select == "topo" and tr) else sc["key"]
            gain = score - state["best"]
            if gain > args.min_delta:
                state["since_gain"] = 0
            else:
                state["since_gain"] += 1
            if gain > 0:  # even a tiny gain is a new best model
                state["best"] = score
                torch.save(dict(model=model.state_dict(), encoder=args.encoder, n_classes=n_cls, step=step, score=score,
                                select=args.select, centreline=bool(args.line_head), classes=classes,
                                preset=args.preset, skel_weight=args.skel_weight),
                           os.path.join(args.out, "best.pt"))
            if state["since_gain"] >= args.lr_patience and state["since_gain"] % args.lr_patience == 0 and state["lr"] > 2e-6:
                state["lr"] /= 2
            rec = dict(step=step, loss=run_loss / n_loss, key_iou=sc["key"], miou=sc["miou"], score=score, topo=tr,
                       iou={c: round(float(v), 4) for c, v in zip(classes, sc["iou"])},
                       recall={c: round(float(v), 4) for c, v in zip(classes, sc["recall"])},
                       lr=state["lr"], since_gain=state["since_gain"], minutes=(time.time() - t0) / 60, real=rc)
            log.write(json.dumps(rec) + "\n"); log.flush()
            tqdm.write(f"[eval {step}] key IoU {sc['key']:.4f} (best {state['best']:.4f})  mIoU {sc['miou']:.4f}  "
                       + "  ".join(f"{c[:4]} {v:.3f}" for c, v in zip(classes, sc["iou"]))
                       + (f"  || topo {tr['topo_score']:.3f} rooms {tr['room_closure_bridged']} lines {tr['centreline_recall']}"
                          f" false-walls {tr['false_wall_rate']}" if tr else "")
                       + f"  | no-gain {state['since_gain']}/{args.patience}  lr {state['lr']:.1e}"
                       + (f"  || REAL coworking: wall-lines {rc['line_mean']}%  AP {rc['ap_found']}/{rc['ap_expected']}  plan2 {rc.get('plan2_found')}" if rc else ""))
            run_loss, n_loss = 0.0, 0
            if not args.smoke:
                torch.save(dict(model=model.state_dict(), opt=opt.state_dict(), state=state), ck)
            if step >= args.min_steps and state["since_gain"] >= args.patience:
                stop = f"no gain above {args.min_delta} for {args.patience} evaluations"
            if step >= args.max_steps:
                stop = stop or "reached max steps"
        if stop:
            break
    bar.close()
    dt = time.time() - t0
    done = state["step"] - step0
    print(f"\nstopped: {stop}.  {done} steps in {fmt_t(dt)} ({done / dt:.2f} step/s)  "
          f"peak GPU memory {torch.cuda.max_memory_allocated() / 1e9:.1f} GB")
    if args.smoke:
        per = dt / max(done, 1)
        print(f"speed -> one pass over the train set ({len(train_items) // args.batch} steps) ~ "
              f"{fmt_t(per * len(train_items) / args.batch)};  20,000 steps ~ {fmt_t(per * 20000)};  "
              f"60,000 steps ~ {fmt_t(per * 60000)}")


if __name__ == "__main__":
    main()
