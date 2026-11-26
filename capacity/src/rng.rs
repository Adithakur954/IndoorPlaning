//! Seeded random numbers (xoshiro256** seeded by splitmix64): the same seed
//! gives the same sequence on every platform, so every run can be replayed.

pub fn splitmix64(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The seed of one iteration, from the run's master seed.
pub fn iteration_seed(master: u64, i: usize) -> u64 {
    let mut x = master ^ (i as u64).wrapping_add(1).wrapping_mul(0xD1B5_4A32_D192_ED03);
    splitmix64(&mut x)
}

pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut x = seed;
        let mut s = [0u64; 4];
        for v in &mut s {
            *v = splitmix64(&mut x);
        }
        Rng { s }
    }

    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1).
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform integer in [0, n).
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        ((self.f64() * n as f64) as usize).min(n - 1)
    }

    /// floor(x), plus one with probability frac(x): the expected value is x.
    pub fn round_stochastic(&mut self, x: f64) -> usize {
        if !(x > 0.0) || !x.is_finite() {
            return 0;
        }
        let f = x.floor();
        f as usize + usize::from(self.f64() < x - f)
    }

    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = self.below(i + 1);
            v.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reproducible_and_uniform() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        let xs: Vec<f64> = (0..1000).map(|_| a.f64()).collect();
        let ys: Vec<f64> = (0..1000).map(|_| b.f64()).collect();
        assert_eq!(xs, ys);
        let mean = xs.iter().sum::<f64>() / 1000.0;
        assert!((mean - 0.5).abs() < 0.05);
        assert!(xs.iter().all(|x| (0.0..1.0).contains(x)));
        assert_ne!(iteration_seed(1, 0), iteration_seed(1, 1));
    }

    #[test]
    fn stochastic_rounding_keeps_the_mean() {
        let mut r = Rng::new(3);
        let n: usize = (0..10_000).map(|_| r.round_stochastic(1.5)).sum();
        assert!((n as f64 / 10_000.0 - 1.5).abs() < 0.03);
    }
}
