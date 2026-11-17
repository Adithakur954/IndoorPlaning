"""python -m floorplan job.json                   reconstruct (image, out_dir, scale, options)
python -m floorplan preview <input> <out.png>   normalised PNG of an image or PDF page"""
import json
import sys

from .pipeline import reconstruct


def preview(src: str, dst: str, max_side: int = 1800, page: int = 0) -> int:
    """A normalised PNG of the input (also for PDF pages) for scale calibration."""
    import cv2

    from .preprocess import load_image, normalise_size

    image, pages = load_image(src, page=page)
    original = (image.shape[1], image.shape[0])
    small, factor = normalise_size(image, max_side)
    cv2.imwrite(dst, small)
    print(json.dumps({"status": "done", "width": small.shape[1], "height": small.shape[0],
                      "originalWidth": original[0], "originalHeight": original[1],
                      "previewScale": factor, "pages": pages}))
    return 0


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == "preview":
        try:
            return preview(sys.argv[2], sys.argv[3])
        except Exception as error:  # reported to the caller
            print(json.dumps({"status": "failed", "error": str(error)}))
            return 1
    if len(sys.argv) < 2:
        print("usage: python -m floorplan job.json | preview <input> <out.png>", file=sys.stderr)
        return 2
    job = json.loads(open(sys.argv[1], encoding="utf-8").read())
    try:
        result = reconstruct(job["image"], job["out_dir"], scale=job.get("scale"),
                             options=job.get("options"))
    except Exception as error:  # reported to the caller as a failed job
        print(json.dumps({"status": "failed", "error": str(error)}))
        return 1
    print(json.dumps({"status": "done", "walls": len(result["walls"]),
                      "rooms": len(result["rooms"]), "openings": len(result["openings"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
