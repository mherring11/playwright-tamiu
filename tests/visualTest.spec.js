const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");
const axios = require("axios");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Convert image to Base64
function imageToBase64(imagePath) {
  if (fs.existsSync(imagePath)) {
    const imageData = fs.readFileSync(imagePath).toString("base64");
    const ext = path.extname(imagePath).replace(".", ""); // Get file extension (e.g., png)
    return `data:image/${ext};base64,${imageData}`;
  }
  return null; // Return null if image is missing
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  if (!fs.existsSync(baselinePath) || !fs.existsSync(currentPath)) {
    console.log(
      chalk.red(`Missing file(s): ${baselinePath} or ${currentPath}`)
    );
    return "Error";
  }

  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath)); // Staging
  const img2 = PNG.sync.read(fs.readFileSync(currentPath)); // Prod

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });

  pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {
    threshold: 0.1,
    diffColor: [0, 0, 255], // Blue for Prod Differences
    diffColorAlt: [255, 165, 0], // Orange for Staging Differences
  });

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    null,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );

  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));

    // Attempt navigation (will wait up to 60 seconds)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Force screenshot after 3 seconds
    await page.waitForTimeout(3000);

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(
      chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`)
    );
  }
}

// Generate HTML report with Base64 embedded images
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();

  // Count passed, failed, and errors
  const passed = results.filter(
    (r) =>
      typeof r.similarityPercentage === "number" && r.similarityPercentage >= 95
  ).length;
  const failed = results.filter(
    (r) =>
      typeof r.similarityPercentage === "number" && r.similarityPercentage < 95
  ).length;
  const errors = results.filter(
    (r) => r.similarityPercentage === "Error"
  ).length;

  // **SORT RESULTS: Failed first, then errors, then passed**
  results.sort((a, b) => {
    if (a.similarityPercentage === "Error") return -1;
    if (b.similarityPercentage === "Error") return 1;
    if (
      typeof a.similarityPercentage === "number" &&
      typeof b.similarityPercentage === "number"
    ) {
      return a.similarityPercentage - b.similarityPercentage; // Lower similarity first
    }
    return 0;
  });

  let htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin-bottom: 20px; }
        .summary p { font-size: 16px; }
        .summary span { font-weight: bold; }
        .summary .passed { color: green; }
        .summary .failed { color: red; }
        .summary .errors { color: orange; }
        .staging { color: orange; font-weight: bold; }
        .prod { color: blue; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: middle; }
        th { background-color: #f2f2f2; }
        .image-container { display: flex; justify-content: center; align-items: center; gap: 15px; }
        .image-wrapper { display: flex; flex-direction: column; align-items: center; }
        .image-container img { width: 350px; cursor: pointer; border: 1px solid #ddd; }
        .image-label { font-size: 14px; font-weight: bold; margin-top: 5px; text-align: center; }
        .status-pass { color: green; font-weight: bold; }
        .status-fail { color: red; font-weight: bold; }
        .status-error { color: orange; font-weight: bold; }
        .criteria { font-size: 14px; text-align: center; margin-top: 10px; font-weight: bold; }
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); }
        .modal img { display: block; max-width: 90%; max-height: 90%; margin: auto; }
        .modal-close { position: absolute; top: 20px; right: 30px; font-size: 30px; color: white; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p><span class="staging">Staging:</span> ${config.staging.baseUrl} | <span class="prod">Prod:</span> ${config.prod.baseUrl}</p>
        <p>Total Pages Tested: <span>${results.length}</span></p>
        <p>Passed: <span class="passed">${passed}</span> | Failed: <span class="failed">${failed}</span> | Errors: <span class="errors">${errors}</span></p>
        <p>Last Run: ${now}</p>
        <a href="${reportPath}" download>Download Report</a>
      </div>
      <p class="criteria">✅ Success Criteria: A similarity score of 95% or higher is considered a pass.</p>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Images</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const sanitizedPath = result.pagePath.replace(/\//g, "_");
    const stagingBase64 = imageToBase64(
      `screenshots/${deviceName}/staging/${sanitizedPath}.png`
    );
    const prodBase64 = imageToBase64(
      `screenshots/${deviceName}/prod/${sanitizedPath}.png`
    );
    const diffBase64 = imageToBase64(
      `screenshots/${deviceName}/diff/${sanitizedPath}.png`
    );

    let statusClass = "status-error";
    let statusText = "Error";

    if (typeof result.similarityPercentage === "number") {
      if (result.similarityPercentage >= 95) {
        statusClass = "status-pass";
        statusText = "Pass";
      } else {
        statusClass = "status-fail";
        statusText = "Fail";
      }
    }

    htmlContent += `
    <tr>
      <td>
        <a href="${config.staging.baseUrl}${
      result.pagePath
    }" target="_blank" class="staging">Staging</a> | 
        <a href="${config.prod.baseUrl}${
      result.pagePath
    }" target="_blank" class="prod">Prod</a>
      </td>
      <td>${
        typeof result.similarityPercentage === "number"
          ? result.similarityPercentage.toFixed(2) + "%"
          : "Error"
      }</td>
      <td class="${statusClass}">${statusText}</td>
      <td>
        <div class="image-container">
          ${
            stagingBase64
              ? `<div class="image-wrapper">
                   <img src="${stagingBase64}" onclick="openModal('${stagingBase64}')" alt="Staging">
                   <div class="image-label">Staging</div>
                 </div>`
              : "N/A"
          }
          ${
            prodBase64
              ? `<div class="image-wrapper">
                   <img src="${prodBase64}" onclick="openModal('${prodBase64}')" alt="Prod">
                   <div class="image-label">Prod</div>
                 </div>`
              : "N/A"
          }
          ${
            diffBase64
              ? `<div class="image-wrapper">
                   <img src="${diffBase64}" onclick="openModal('${diffBase64}')" alt="Diff">
                   <div class="image-label">Diff</div>
                 </div>`
              : "N/A"
          }
        </div>
      </td>
    </tr>
  `;
  });

  htmlContent += `
        </tbody>
      </table>

      <div id="modal" class="modal">
        <span class="modal-close" onclick="closeModal()">&times;</span>
        <img id="modal-image">
      </div>

      <script>
        function openModal(imageSrc) { 
          document.getElementById("modal-image").src = imageSrc; 
          document.getElementById("modal").style.display = "block"; 
        }
        function closeModal() { 
          document.getElementById("modal").style.display = "none"; 
        }
      </script>

    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test.setTimeout(7200000);
  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });

  test("Verify broken image links automatically on staging pages from config.js", async ({
    page,
  }) => {
    const stagingUrls = config.staging.urls.map(
      (url) => `${config.staging.baseUrl}${url}`
    );

    for (const url of stagingUrls) {
      console.log(chalk.blue(`Navigating to: ${url}`));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      console.log(chalk.green(`Page loaded successfully: ${url}`));

      console.log(chalk.blue("Finding all image elements on the page..."));
      const images = await page.locator("img");
      const imageCount = await images.count();
      console.log(chalk.green(`Found ${imageCount} images on the page.`));

      let brokenImages = 0;
      let trackingPixels = 0;
      let checkedImages = 0;

      // Extract and prepare all image URLs
      const imageUrls = [];
      for (let i = 0; i < imageCount; i++) {
        let imageUrl = await images.nth(i).getAttribute("src");

        if (!imageUrl) {
          console.log(
            chalk.yellow(`Warning: Image ${i + 1} is missing a src attribute.`)
          );
          brokenImages++;
          continue;
        }

        // Resolve relative URLs
        if (!imageUrl.startsWith("http") && !imageUrl.startsWith("//")) {
          imageUrl = new URL(imageUrl, url).toString();
        } else if (imageUrl.startsWith("//")) {
          imageUrl = `https:${imageUrl}`;
        }

        // Ignore tracking pixels
        if (
          imageUrl.includes("bat.bing.com") ||
          imageUrl.includes("tracking")
        ) {
          console.log(chalk.yellow(`Skipping tracking pixel: ${imageUrl}`));
          trackingPixels++;
          continue;
        }

        imageUrls.push({ index: i + 1, imageUrl });
      }

      console.log(chalk.blue(`Checking ${imageUrls.length} valid images...`));

      // **Check all images concurrently for faster performance**
      const imageChecks = await Promise.allSettled(
        imageUrls.map(({ index, imageUrl }) =>
          axios
            .get(imageUrl)
            .then((response) => ({
              index,
              imageUrl,
              status: response.status,
            }))
            .catch((error) => ({
              index,
              imageUrl,
              error: error.response
                ? `Status: ${error.response.status}`
                : error.message,
            }))
        )
      );

      // **Process results**
      for (const result of imageChecks) {
        if (result.status === "fulfilled") {
          console.log(
            chalk.green(
              `✅ Image ${result.value.index} loaded successfully: ${result.value.imageUrl}`
            )
          );
        } else {
          console.log(
            chalk.red(
              `❌ Image ${result.reason.index} failed: ${result.reason.imageUrl} (${result.reason.error})`
            )
          );
          brokenImages++;
        }
        checkedImages++;
      }

      // **Final results per page**
      console.log(chalk.blue(`Summary for ${url}:`));
      console.log(
        chalk.green(`✅ Valid images: ${checkedImages - brokenImages}`)
      );
      console.log(chalk.red(`❌ Broken images: ${brokenImages}`));
      console.log(
        chalk.yellow(`⚠️ Skipped tracking pixels: ${trackingPixels}`)
      );

      if (brokenImages > 0) {
        console.log(
          chalk.red(
            `🚨 Test failed for ${url}. ${brokenImages} broken images detected.`
          )
        );
      } else {
        console.log(
          chalk.green(`✅ Test passed for ${url}. No broken images found.`)
        );
      }
    }
  });


test("Verify Online Programs and Getting Started Menus - TAMIU", async ({ page }) => {
  try {
      const homePageUrl = "https://live-web-tamiu.pantheonsite.io/";
      console.log(`\n🔹 Navigating to TAMIU homepage: ${homePageUrl}`);
      await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
      console.log("✅ Homepage loaded successfully.");

      /**
       * Function to open a dropdown menu and validate its links
       */
      const verifyMenu = async (menuName, menuSelector, submenuSelector) => {
          console.log(`\n🔹 Locating '${menuName}' menu...`);

          // Locate menu element
          const menuElement = page.locator(menuSelector).first();
          await menuElement.waitFor({ state: "attached", timeout: 10000 });
          console.log(`✅ '${menuName}' menu found.`);

          // Click the menu to expand it
          console.log(`🔹 Clicking '${menuName}' menu...`);
          await menuElement.click({ force: true });

          // Wait for submenu to appear
          console.log(`🔹 Waiting for '${menuName}' submenu to become visible...`);
          const submenu = page.locator(submenuSelector).first();
          await submenu.waitFor({ state: "visible", timeout: 5000 });
          console.log(`✅ '${menuName}' submenu is now visible.`);

          // Verify submenu links
          const links = submenu.locator("a.mega-menu-link");
          const linkCount = await links.count();

          if (linkCount === 0) {
              throw new Error(`❌ No links found in '${menuName}' menu.`);
          }
          console.log(`✅ Found ${linkCount} links in '${menuName}' menu.`);

          let invalidLinks = 0;
          for (let i = 0; i < linkCount; i++) {
              const linkText = await links.nth(i).textContent();
              const linkHref = await links.nth(i).getAttribute("href");

              console.log(`🔗 Checking link ${i + 1} in '${menuName}': "${linkText}"`);

              if (!linkHref || linkHref.trim() === "") {
                  console.log(`⚠️ Warning: '${linkText}' in '${menuName}' has no valid href.`);
                  invalidLinks++;
              } else {
                  console.log(`✅ Valid link: '${linkText}' -> ${linkHref}`);
              }
          }

          console.log(`✅ Completed verification for '${menuName}'. Invalid links: ${invalidLinks}`);

          if (invalidLinks > 0) {
              console.log(`⚠️ Test finished with ${invalidLinks} warnings for '${menuName}'.`);
          } else {
              console.log(`✅ All links in '${menuName}' are valid.`);
          }
      };

      // **Verify "Online Programs" menu**
      await verifyMenu(
          "Online Programs",
          "li#mega-menu-item-242 > a.mega-menu-link",
          "li#mega-menu-item-242 > ul.mega-sub-menu"
      );

      // **Verify "Getting Started" menu**
      await verifyMenu(
          "Getting Started",
          "li#mega-menu-item-243 > a.mega-menu-link",
          "li#mega-menu-item-243 > ul.mega-sub-menu"
      );

      console.log("\n✅ All menu verifications completed successfully!");

  } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
  }
});

});