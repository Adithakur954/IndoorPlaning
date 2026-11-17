"""SNR of a radio map: strongest AP's power minus the thermal noise floor of its channel."""
import unittest

import numpy as np

from sionna_worker.job import JobError, JobSettings
from sionna_worker.snr import ap_bandwidth_mhz, noise_floor_dbm, snr_grid, strongest_snr


class SnrTest(unittest.TestCase):
    def test_optimization_snr_follows_strongest_signal_and_preserves_no_signal(self):
        rows = np.array([[-50, -60, -200], [-49, -70, -200]], dtype=np.float16)
        # The stronger AP in column 0 has a wider, noisier channel. Choosing
        # the highest SNR instead would incorrectly return 38 there.
        np.testing.assert_allclose(strongest_snr(rows, [-88, -82]), [33, 28, -200])
        np.testing.assert_allclose(strongest_snr(np.empty((0, 3)), []), [-200] * 3)

    def test_noise_floor_follows_the_channel_width(self):
        # the floor is given for 20 MHz; each doubling of the width adds 3 dB
        self.assertAlmostEqual(noise_floor_dbm(-88, 20), -88.0, places=2)
        self.assertAlmostEqual(noise_floor_dbm(-88, 40), -84.99, places=2)
        self.assertAlmostEqual(noise_floor_dbm(-88, 80), -81.98, places=2)
        self.assertAlmostEqual(noise_floor_dbm(-86, 20), -86.0, places=2)

    def test_a_higher_noise_floor_lowers_the_snr_by_the_same_amount(self):
        best = np.array([[-54.0]])
        idx = np.array([[0]])
        old = snr_grid(best, idx, [-94.0])[0, 0]
        new = snr_grid(best, idx, [-88.0])[0, 0]
        self.assertEqual((old, new), (40.0, 34.0))

    def test_snr_uses_the_noise_of_the_best_aps_own_channel(self):
        best_dbm = np.array([[-50.0, -60.0], [-70.0, -90.0]])
        best_index = np.array([[0, 1], [0, 1]])
        noise = np.array([-94.0, -91.0])   # AP 0 on 20 MHz, AP 1 on 40 MHz
        snr = snr_grid(best_dbm, best_index, noise)
        np.testing.assert_allclose(snr, [[44.0, 31.0], [24.0, 1.0]])

    def test_missing_bandwidth_is_assumed_to_be_20_mhz(self):
        self.assertEqual(ap_bandwidth_mhz({"bandwidthMHz": 40}), (40.0, False))
        self.assertEqual(ap_bandwidth_mhz({"bandwidthMHz": None}), (20.0, True))
        self.assertEqual(ap_bandwidth_mhz({}), (20.0, True))

    def test_noise_floors_have_defaults_and_are_validated(self):
        base = {"scene_dir": "s", "output_dir": "o"}
        d = JobSettings.from_dict(base)
        self.assertEqual((d.noise_floor_24_dbm, d.noise_floor_5_dbm), (-86.0, -88.0))
        for key in ("noise_floor_24_dbm", "noise_floor_5_dbm", "noise_floor_6_dbm"):
            for bad in (-120, -50, float("nan")):
                with self.assertRaises(JobError):
                    JobSettings.from_dict({**base, key: bad})
        self.assertEqual(JobSettings.from_dict({**base, "noise_floor_5_dbm": -92}).noise_floor_5_dbm, -92)


if __name__ == "__main__":
    unittest.main()
