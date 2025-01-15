const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

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

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`));
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Forcefully capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));

    const navigationPromise = page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => {
        console.log(chalk.red(`Timeout detected on ${url}. Forcing screenshot.`));
        resolve();
      }, 10000) // Timeout after 10 seconds
    );

    await Promise.race([navigationPromise, timeoutPromise]);

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`));
    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Forced screenshot captured: ${screenshotPath}`));
  }
}

// Generate HTML report
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();
  const environments = `
    <a href="${config.staging.baseUrl}" target="_blank">Staging: ${config.staging.baseUrl}</a>,
    <a href="${config.prod.baseUrl}" target="_blank">Prod: ${config.prod.baseUrl}</a>
  `;

  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
        th { background-color: #f2f2f2; }
        .pass { color: green; font-weight: bold; }
        .fail { color: red; font-weight: bold; }
        .error { color: orange; font-weight: bold; }
        img { max-width: 150px; cursor: pointer; }
        #modal {
          display: none;
          position: fixed;
          z-index: 1000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          overflow: auto;
          background-color: rgba(0, 0, 0, 0.8);
        }
        #modal img {
          display: block;
          margin: 50px auto;
          max-width: 80%;
        }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p>Total Pages Tested: ${results.length}</p>
        <p>Passed: ${
          results.filter((r) => typeof r.similarityPercentage === "number" && r.similarityPercentage >= 95).length
        }</p>
        <p>Failed: ${
          results.filter((r) => typeof r.similarityPercentage === "number" && r.similarityPercentage < 95).length
        }</p>
        <p>Errors: ${results.filter((r) => r.similarityPercentage === "Error").length}</p>
        <p>Last Run: ${now}</p>
        <p>Environments Tested: ${environments}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Thumbnail</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const diffThumbnailPath = `screenshots/${deviceName}/diff/${result.pagePath.replace(/\//g, "_")}.png`;

    const stagingUrl = `${config.staging.baseUrl}${result.pagePath}`;
    const prodUrl = `${config.prod.baseUrl}${result.pagePath}`;

    const statusClass =
      typeof result.similarityPercentage === "number" &&
      result.similarityPercentage >= 95
        ? "pass"
        : "fail";

    htmlContent += `
      <tr>
        <td>
          <a href="${stagingUrl}" target="_blank">Staging</a> |
          <a href="${prodUrl}" target="_blank">Prod</a>
        </td>
        <td>${
          typeof result.similarityPercentage === "number"
            ? result.similarityPercentage.toFixed(2) + "%"
            : result.similarityPercentage
        }</td>
        <td class="${statusClass}">${
      result.similarityPercentage === "Error"
        ? "Error"
        : result.similarityPercentage >= 95
        ? "Pass"
        : "Fail"
    }</td>
        <td>${
          fs.existsSync(diffThumbnailPath)
            ? `<a href="${diffThumbnailPath}" target="_blank"><img src="${diffThumbnailPath}" /></a>`
            : "N/A"
        }</td>
      </tr>
    `;
  });

  htmlContent += `
        </tbody>
      </table>
      <div id="modal" onclick="closeModal()">
        <img id="modal-image" src="" />
      </div>
      <script>
        function openModal(src) {
          const modal = document.getElementById('modal');
          const modalImg = document.getElementById('modal-image');
          modalImg.src = src;
          modal.style.display = 'block';
        }
        function closeModal() {
          document.getElementById('modal').style.display = 'none';
        }
      </script>
    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test("Compare staging and prod screenshots and generate HTML report", async ({ browser }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(baseDir, "staging", `${pagePath.replace(/\//g, "_")}.png`);
      const prodScreenshotPath = path.join(baseDir, "prod", `${pagePath.replace(/\//g, "_")}.png`);
      const diffScreenshotPath = path.join(baseDir, "diff", `${pagePath.replace(/\//g, "_")}.png`);

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(stagingScreenshotPath, prodScreenshotPath, diffScreenshotPath);

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({ pagePath, similarityPercentage: "Error", error: error.message });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });

  test("Fill out the form and submit", async ({ page }) => {
    const formPageUrl = "https://live-web-tamiu.pantheonsite.io/"; // Replace with the actual form URL
    console.log(chalk.blue(`Navigating to the form page: ${formPageUrl}`));
    await page.goto(formPageUrl, { waitUntil: "domcontentloaded" });
  
    // Fill the form fields
    console.log(chalk.blue("Filling out the form fields..."));
    await page.selectOption("#input_2_1", { value: "TAMIU-M-CJ" }); // Select "M.S. in Criminal Justice"
    await page.fill("#input_2_2", "John");
    await page.fill("#input_2_3", "Doe");
    await page.fill("#input_2_6", "johndoe@example.com");
    await page.fill("#input_2_4", "5551234567");
    await page.fill("#input_2_5", "12345");
    await page.selectOption("#input_2_7", { value: "Email" });
  
    // Submit the form
    console.log(chalk.blue("Submitting the form..."));
    await page.click("#gform_submit_button_2");
  
    // Wait for confirmation message
    console.log(chalk.blue("Waiting for confirmation message..."));
    const confirmationSelector = ".elementor-widget-container h1.header2";
    try {
      await page.waitForSelector(confirmationSelector, { timeout: 15000 }); // Wait for the confirmation message to appear
      const confirmationText = await page.textContent(confirmationSelector);
  
      if (confirmationText.includes("Thanks for your submission!")) {
        console.log(chalk.green("Form submitted successfully and confirmation message displayed."));
      } else {
        console.log(chalk.red("Confirmation message text did not match expected value."));
      }
    } catch (error) {
      console.error(chalk.red(`Error waiting for confirmation message: ${error.message}`));
    }
  });
  
  test("Click Apply Now, fill out the form, and submit", async ({ page }) => {
    // Navigate to the homepage
    const homePageUrl = "https://live-web-tamiu.pantheonsite.io/";
    console.log(chalk.blue(`Navigating to the home page: ${homePageUrl}`));
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
  
    // Click on the "Apply Now" button
    const applyNowSelector = "li.apply-now a.elementor-item";
    console.log(chalk.blue("Clicking on 'Apply Now' button..."));
    await page.click(applyNowSelector);
  
    // Wait for the form page to load
    const formPageUrl = "https://live-web-tamiu.pantheonsite.io/apply/";
    await page.waitForURL(formPageUrl, { timeout: 10000 });
    console.log(chalk.green("Navigated to the Apply Now form page."));
  
    // Fill the form fields
    console.log(chalk.blue("Filling out the Apply Now form fields..."));
    await page.selectOption("#input_1_1", { value: "TAMIU-M-MBAINTLBUS" }); // Select "MBA in International Business"
    await page.fill("#input_1_2", "Jane");
    await page.fill("#input_1_3", "Smith");
    await page.fill("#input_1_4", "janesmith@example.com");
    await page.fill("#input_1_5", "5559876543");
    await page.fill("#input_1_6", "54321");
    await page.selectOption("#input_1_7", { value: "Online" });
  
    // Submit the form and wait for navigation
    console.log(chalk.blue("Submitting the Apply Now form and waiting for navigation..."));
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }), // Wait for the new page to load
      page.click("#gform_submit_button_1"),
    ]);
    console.log(chalk.green("Form submitted, and navigated to the confirmation page."));
  
    // Wait for the confirmation message to appear
    console.log(chalk.blue("Waiting for confirmation message on the new page..."));
    const confirmationSelector = ".elementor-widget-container h1.header2";
    try {
      await page.waitForSelector(confirmationSelector, { timeout: 15000 }); // Wait for the confirmation message
      const confirmationText = await page.textContent(confirmationSelector);
  
      // Log the confirmation message to debug potential issues
      console.log(chalk.blue(`Confirmation message found: "${confirmationText.trim()}"`));
  
      if (confirmationText.trim() === "Great! Now, take the next step.") {
        console.log(chalk.green("Form submitted successfully and confirmation message displayed."));
      } else {
        console.log(chalk.red("Confirmation message text did not match expected value."));
      }
    } catch (error) {
      console.error(chalk.red(`Error waiting for confirmation message: ${error.message}`));
    }
  });  
});
