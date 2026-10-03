//! Pure window-placement math (logical points, top-left origin like AppKit-via-tao).

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl RectF {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    fn right(&self) -> f64 {
        self.x + self.w
    }

    fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

/// Edge margin kept between popups and the screen edge.
pub const SCREEN_MARGIN: f64 = 8.0;
/// Gap between the menu bar icon and the popover.
pub const POPOVER_GAP: f64 = 6.0;

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if max < min {
        min
    } else {
        value.clamp(min, max)
    }
}

/// Places a popover of `size` horizontally centred under `anchor` (the tray icon), clamped to
/// the work area so it never runs off the right edge (icons near the clock).
pub fn popover_origin(anchor: RectF, size: (f64, f64), work_area: RectF) -> (f64, f64) {
    let (w, h) = size;
    let centred_x = anchor.x + anchor.w / 2.0 - w / 2.0;
    let x = clamp(
        centred_x,
        work_area.x + SCREEN_MARGIN,
        work_area.right() - w - SCREEN_MARGIN,
    );
    // Below the icon; the menu bar is above the work area, so never start above it.
    let below = anchor.bottom() + POPOVER_GAP;
    let y = clamp(
        below.max(work_area.y),
        work_area.y,
        work_area.bottom() - h - SCREEN_MARGIN,
    );
    (x.round(), y.round())
}

/// Fallback when no tray rect is known: top-right corner of the work area.
pub fn popover_fallback_origin(size: (f64, f64), work_area: RectF) -> (f64, f64) {
    let x = work_area.right() - size.0 - SCREEN_MARGIN;
    let y = work_area.y + POPOVER_GAP;
    (x.max(work_area.x).round(), y.round())
}

/// Spotlight-like placement: horizontally centred, upper part of the screen.
pub fn palette_origin(work_area: RectF, size: (f64, f64)) -> (f64, f64) {
    let (w, h) = size;
    let x = work_area.x + (work_area.w - w) / 2.0;
    let y = work_area.y + (work_area.h * 0.22).min(work_area.h - h - SCREEN_MARGIN);
    (x.max(work_area.x).round(), y.max(work_area.y).round())
}

/// Clicking the tray icon while the popover is open first blurs (and hides) it, then delivers
/// the click; without this debounce the click would immediately reopen it.
pub const REOPEN_DEBOUNCE: Duration = Duration::from_millis(300);

pub fn should_open_after_click(last_hidden_by_blur: Option<Instant>, now: Instant) -> bool {
    match last_hidden_by_blur {
        Some(t) => now.saturating_duration_since(t) > REOPEN_DEBOUNCE,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: RectF = RectF {
        x: 0.0,
        y: 25.0,
        w: 1512.0,
        h: 957.0,
    };

    #[test]
    fn popover_is_centred_under_icon() {
        let icon = RectF::new(1000.0, 0.0, 30.0, 24.0);
        let (x, y) = popover_origin(icon, (380.0, 540.0), SCREEN);
        assert_eq!(x, (1015.0f64 - 190.0).round());
        assert_eq!(y, 30.0);
    }

    #[test]
    fn popover_is_clamped_at_right_edge() {
        let icon = RectF::new(1480.0, 0.0, 28.0, 24.0);
        let (x, _) = popover_origin(icon, (380.0, 540.0), SCREEN);
        assert_eq!(x, 1512.0 - 380.0 - SCREEN_MARGIN);
    }

    #[test]
    fn popover_is_clamped_at_left_edge_and_bottom() {
        let icon = RectF::new(2.0, 0.0, 28.0, 24.0);
        let small = RectF::new(0.0, 25.0, 800.0, 400.0);
        let (x, y) = popover_origin(icon, (380.0, 540.0), small);
        assert_eq!(x, SCREEN_MARGIN);
        assert_eq!(y, 25.0);
    }

    #[test]
    fn popover_works_on_secondary_display() {
        let display = RectF::new(1512.0, 25.0, 1920.0, 1055.0);
        let icon = RectF::new(3000.0, 0.0, 30.0, 24.0);
        let (x, y) = popover_origin(icon, (380.0, 540.0), display);
        assert!(x >= display.x && x + 380.0 <= display.x + display.w);
        assert_eq!(y, 30.0);
    }

    #[test]
    fn fallback_is_top_right() {
        let (x, y) = popover_fallback_origin((380.0, 540.0), SCREEN);
        assert_eq!(x, 1512.0 - 380.0 - SCREEN_MARGIN);
        assert_eq!(y, 25.0 + POPOVER_GAP);
    }

    #[test]
    fn palette_is_centred_high() {
        let (x, y) = palette_origin(SCREEN, (680.0, 440.0));
        assert_eq!(x, 416.0);
        assert_eq!(y, (25.0f64 + 957.0 * 0.22).round());
        // Tiny screen: never above the work area.
        let tiny = RectF::new(0.0, 25.0, 600.0, 300.0);
        let (x, y) = palette_origin(tiny, (680.0, 440.0));
        assert_eq!((x, y), (0.0, 25.0));
    }

    #[test]
    fn debounce_blocks_immediate_reopen() {
        let now = Instant::now();
        assert!(should_open_after_click(None, now));
        assert!(!should_open_after_click(
            Some(now),
            now + Duration::from_millis(50)
        ));
        assert!(should_open_after_click(
            Some(now),
            now + Duration::from_millis(500)
        ));
    }
}
