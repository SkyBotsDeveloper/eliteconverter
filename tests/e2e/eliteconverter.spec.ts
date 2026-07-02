import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("landing page, navigation and accessibility", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "EliteConverter" })).toBeVisible();
  await expect(page.getByLabel("Source URL")).toBeVisible();

  const menu = page.getByLabel("Open navigation");
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole("link", { name: "Docs", exact: true }).click();
  } else {
    await page.getByRole("link", { name: "Docs", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/docs/);
  await expect(page.getByRole("heading", { name: "EliteConverter API" })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("conversion form validates permission and completes mock conversion", async ({ page }) => {
  await page.goto("/convert");
  await page.getByLabel("Source URL").fill("not-a-url");
  await page.getByRole("button", { name: /Start conversion/ }).click();
  await expect(page.getByText("Enter a valid media URL")).toBeVisible();

  await page.getByLabel("Source URL").fill("https://media.example.com/input.mp4?mock=success");
  await page.getByLabel("Only convert media").check();
  await page.getByRole("button", { name: /Start conversion/ }).click();
  await expect(page).toHaveURL(/\/jobs\/ec_job_demo_/);
  await expect(page.getByText("completed").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Download/ })).toBeVisible();
});

test("mock failure flow shows safe error", async ({ page }) => {
  await page.goto("/convert");
  await page.getByLabel("Source URL").fill("https://media.example.com/input.mp4?mock=fail");
  await page.getByLabel("Only convert media").check();
  await page.getByRole("button", { name: /Start conversion/ }).click();
  await expect(page).toHaveURL(/\/jobs\/ec_job_demo_/);
  await expect(page.getByText("The conversion failed.")).toBeVisible();
});

test("documentation search, theme switching, status and 404", async ({ page }) => {
  await page.goto("/docs");
  await page.getByLabel("Search docs").fill("webhooks");
  await expect(page.getByRole("link", { name: "Webhooks" })).toBeVisible();
  await page.getByLabel(/^Theme:/).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /dark|light/);
  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
  await page.goto("/missing-page");
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
});
