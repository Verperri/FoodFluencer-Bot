// Tests for the Auto Bot UI overhaul:
//  - Manual Post / Auto Bot Region Roundup caption defaults (Ratings + Review
//    Counts on, Hashtags off) and "🎲 Random Region" resolution to a real province.
//  - The combined "Active Bots" overview card shows/hides based on activation state.
//  - The per-bot-type schedule groups are collapsible and show a live summary.
//  - The Activity Log is collapsible without the filter/reset controls
//    accidentally toggling it.

const { loadPopupDom } = require('./helpers/popup-dom');

describe('Region Roundup caption defaults', () => {
  test('getManualRoundupSettings defaults to Ratings + Review Counts on, Hashtags off', async () => {
    const { popup } = await loadPopupDom();
    const settings = popup.getManualRoundupSettings();
    expect(settings.captionOpts.showRatings).toBe(true);
    expect(settings.captionOpts.showReviewCount).toBe(true);
    expect(settings.captionOpts.hashtags).toBe(false);
  });

  test('getRegionRoundupSettings defaults to Ratings + Review Counts on, Hashtags off', async () => {
    const { popup } = await loadPopupDom();
    const settings = popup.getRegionRoundupSettings();
    expect(settings.captionOpts.showRatings).toBe(true);
    expect(settings.captionOpts.showReviewCount).toBe(true);
    expect(settings.captionOpts.hashtags).toBe(false);
  });

  test('getManualRoundupSettings resolves "🎲 Random Region" to a real Belgian province', async () => {
    const { popup } = await loadPopupDom();
    const sel = document.getElementById('mrRegion');
    sel.value = '__random__';

    const settings = popup.getManualRoundupSettings();
    expect(settings.region).not.toBe('__random__');
    expect(popup.REGIONS.BE).toContain(settings.region);
  });
});

describe('Active Bots overview card', () => {
  test('hidden when no bot is active, shown with summary once Auto Bot is activated', async () => {
    await loadPopupDom();

    const wrap   = document.getElementById('abActiveBotsWrap');
    const status = document.getElementById('abBotStatus');
    const summary = document.getElementById('abScheduleSummary');

    expect(wrap.classList.contains('hidden')).toBe(true);
    expect(summary.textContent).toMatch(/Not scheduled/);

    document.getElementById('abScheduleBtn').click();

    expect(wrap.classList.contains('hidden')).toBe(false);
    expect(status.classList.contains('hidden')).toBe(false);
    expect(summary.textContent).toMatch(/🟢 Active/);

    // Deactivating hides the card again
    document.getElementById('abScheduleBtn').click();

    expect(wrap.classList.contains('hidden')).toBe(true);
    expect(summary.textContent).toMatch(/Not scheduled/);
  });
});

describe('Collapsible schedule groups', () => {
  test('Singular Horeca Post schedule group starts collapsed and toggles open on click', async () => {
    await loadPopupDom();

    const body  = document.getElementById('abScheduleBody');
    const arrow = document.getElementById('abScheduleArrow');
    expect(body.classList.contains('collapsed')).toBe(true);
    expect(arrow.classList.contains('collapsed')).toBe(true);

    document.getElementById('abScheduleToggle').click();
    expect(body.classList.contains('collapsed')).toBe(false);
    expect(arrow.classList.contains('collapsed')).toBe(false);

    document.getElementById('abScheduleToggle').click();
    expect(body.classList.contains('collapsed')).toBe(true);
  });

  test('Region Round-Up Post schedule group starts collapsed and toggles open on click', async () => {
    await loadPopupDom();

    const body  = document.getElementById('rrScheduleBody');
    const arrow = document.getElementById('rrScheduleArrow');
    expect(body.classList.contains('collapsed')).toBe(true);
    expect(arrow.classList.contains('collapsed')).toBe(true);

    document.getElementById('rrScheduleToggle').click();
    expect(body.classList.contains('collapsed')).toBe(false);
    expect(arrow.classList.contains('collapsed')).toBe(false);
  });
});

describe('Collapsible Activity Log', () => {
  test('starts collapsed and toggles open when the header is clicked', async () => {
    await loadPopupDom();

    const items = document.getElementById('abLogItems');
    const arrow = document.getElementById('abLogArrow');
    expect(items.classList.contains('collapsed')).toBe(true);

    document.getElementById('abLogToggle').click();
    expect(items.classList.contains('collapsed')).toBe(false);
    expect(arrow.classList.contains('collapsed')).toBe(false);

    document.getElementById('abLogToggle').click();
    expect(items.classList.contains('collapsed')).toBe(true);
  });

  test('clicking the filter/reset controls does not toggle the log open', async () => {
    await loadPopupDom();

    const items = document.getElementById('abLogItems');
    expect(items.classList.contains('collapsed')).toBe(true);

    document.getElementById('abLogFilterBtn').click();
    expect(items.classList.contains('collapsed')).toBe(true);
  });
});
