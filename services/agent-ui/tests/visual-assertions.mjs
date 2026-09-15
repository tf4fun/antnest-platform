import assert from "node:assert/strict";

export async function assertReadableText(page, selectors) {
  const failures = await page.evaluate((selectors) => {
    const rgb = (value) => value.match(/[\d.]+/g).map(Number);
    const luminance = (channels) =>
      channels
        .slice(0, 3)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const failures = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!element.checkVisibility()) continue;
        const foreground = luminance(rgb(getComputedStyle(element).color));
        let ancestor = element;
        let background = [255, 255, 255];
        while (ancestor) {
          const color = rgb(getComputedStyle(ancestor).backgroundColor);
          if (color.length === 3 || color[3] === 1) {
            background = color;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const surface = luminance(background);
        const ratio =
          (Math.max(foreground, surface) + 0.05) /
          (Math.min(foreground, surface) + 0.05);
        if (ratio < 4.5)
          failures.push({
            selector,
            text: element.textContent.slice(0, 50),
            ratio,
          });
      }
    }
    return failures;
  }, selectors);
  assert.deepEqual(failures, [], "normal text contrast must reach 4.5:1");
}

export async function assertTouchTargets(page, selector) {
  const failures = await page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => element.checkVisibility())
      .map((element) => ({
        name: element.getAttribute("aria-label") ?? element.textContent,
        bounds: element.getBoundingClientRect(),
      }))
      .filter(({ bounds }) => bounds.width < 44 || bounds.height < 44)
      .map(({ name, bounds }) => ({
        name,
        width: bounds.width,
        height: bounds.height,
      })),
  );
  assert.deepEqual(failures, [], "touch controls must have 44px targets");
}
