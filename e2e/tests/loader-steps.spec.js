/*
  loader-steps.spec.js — the loader's step checklist, asserted as VISIBLE.

  The bug this exists for: LCLoader.steps() painted the list correctly but
  nothing appeared on screen. The cover sits at opacity:0/visibility:hidden
  until it gets the .on class, and the only caller of showCover() was a
  sidebar navigation intent — so an in-page button (Sync now, Fill from
  Odoo) drew its checklist into an invisible element.

  Every assertion here therefore goes through toBeVisible() or a computed
  style. Asserting on textContent or element count would have passed
  against the broken build, which is exactly how it shipped.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

async function coverState(page) {
  return page.evaluate(() => {
    const cover = document.querySelector('.lcl-load');
    const steps = document.querySelector('.lcl-steps');
    if (!cover) return { cover: 'missing' };
    const cs = getComputedStyle(cover);
    return {
      hasOn: cover.classList.contains('on'),
      visibility: cs.visibility,
      opacity: cs.opacity,
      stepsHidden: steps ? steps.hidden : null,
      stepCount: steps ? steps.querySelectorAll('.lcl-step').length : 0,
    };
  });
}

test.describe('loader step checklist', () => {
  test('steps() makes the cover and the list actually visible', async ({ page }) => {
    await loginAs(page, 'stores');
    await page.goto('/purchases.html');
    // Let the page settle so finish() has run — the exact state that used
    // to swallow a later steps() call.
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.LCLoader && window.LCLoader.done && window.LCLoader.done());
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      window.LCLoader.caption('Pulling the last 7 days from Odoo…');
      window.LCLoader.steps(['Gate entries', 'GRN register', 'Material issues']);
      window.LCLoader.step(0, 'run');
    });

    /* The cover fades in over .18s (styles.css .lcl-load transition), so
       sample AFTER that completes — reading opacity mid-transition is a
       race, not a defect. toBeVisible() below is the assertion that would
       catch a genuinely hidden cover. */
    await expect(page.locator('.lcl-steps')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(350);

    const st = await coverState(page);
    expect(st.hasOn, 'cover must carry .on').toBe(true);
    expect(st.visibility, 'cover must not be visibility:hidden').toBe('visible');
    expect(Number(st.opacity), 'cover must not be transparent').toBeGreaterThan(0.5);
    expect(st.stepsHidden, 'the <ol> must not be hidden').toBe(false);
    expect(st.stepCount).toBe(3);

    await expect(page.locator('.lcl-steps')).toBeVisible();
    await expect(page.locator('.lcl-step').first()).toBeVisible();
    await expect(page.locator('.lcl-step').first()).toContainText('Gate entries');
    await expect(page.locator('.lcl-step.is-run')).toHaveCount(1);
    await expect(page.locator('.lcl-caption')).toContainText('Pulling the last 7 days');
  });

  test('step() marks progress and notes on screen', async ({ page }) => {
    await loginAs(page, 'stores');
    await page.goto('/purchases.html');
    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      window.LCLoader.steps(['Gate entries', 'GRN register', 'Material issues']);
      window.LCLoader.step(0, 'ok', '208 rows');
      window.LCLoader.step(1, 'fail');
      window.LCLoader.step(2, 'run');
    });

    await expect(page.locator('.lcl-step.is-ok')).toHaveCount(1);
    await expect(page.locator('.lcl-step.is-fail')).toHaveCount(1);
    await expect(page.locator('.lcl-step.is-run')).toHaveCount(1);
    await expect(page.locator('.lcl-step.is-ok')).toContainText('208 rows');

    /* Failure must be marked by more than colour — the "one dimension, one
       channel" rule. The dot carries a ring via box-shadow. */
    const ring = await page.locator('.lcl-step.is-fail .lcl-step-dot')
      .evaluate(el => getComputedStyle(el).boxShadow);
    expect(ring === 'none' || ring === '', 'failed step needs a non-colour cue').toBe(false);
  });

  test('done() takes the cover back down', async ({ page }) => {
    await loginAs(page, 'stores');
    await page.goto('/purchases.html');
    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      window.LCLoader.steps(['One', 'Two']);
      window.LCLoader.step(0, 'run');
    });
    await expect(page.locator('.lcl-steps')).toBeVisible();

    await page.evaluate(() => window.LCLoader.done());
    await expect(page.locator('.lcl-load')).not.toHaveClass(/\bon\b/, { timeout: 5000 });
  });

  test('the real Sync now button shows the checklist', async ({ page }) => {
    await loginAs(page, 'stores');
    await page.goto('/purchases.html');
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.LCLoader && window.LCLoader.done && window.LCLoader.done());
    await page.waitForTimeout(600);

    const btn = page.locator('#sv-sync');
    await expect(btn).toBeVisible();
    await btn.click();

    /* The pull takes 15-55s; the checklist must appear immediately, which
       is the whole reason it exists. */
    await expect(page.locator('.lcl-steps')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.lcl-step')).toHaveCount(4);
    await expect(page.locator('.lcl-step.is-run').first()).toBeVisible();
  });
});
