import * as cheerio from "cheerio";
import fs from "fs";
import { writeFile, mkdir, readFile } from "fs/promises";
import fetch from "node-fetch";
import config from "./config.json";
import pLimit from "p-limit";

// Interfaces for project configuration
interface Project {
  topic: string;
  url: string;
  disabled?: boolean;
}

interface Config {
  telegramApiToken: string | null;
  chatId: string | null;
  projects: Project[];
}

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
];

// Utility functions
// Function to fetch HTML response from Yad2 with retry mechanism, backoff strategy, and maximum timeout
const getYad2Response = async (url: string, retries = 3, maxTimeout = 10000): Promise<string> => {
  console.log(`Fetching URL: ${url}, Retries left: ${retries}`);
  const requestOptions = {
    method: "GET",
    redirect: "follow" as RequestRedirect,
    headers: {
      "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)],
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.yad2.co.il/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    },
  };

  const backoffDelay = (attempt: number) => Math.pow(2, attempt) * 1000; // Exponential backoff in milliseconds
  const startTime = Date.now();

  while (retries > 0) {
    try {
      // Check if maximum timeout is reached
      if (Date.now() - startTime > maxTimeout) {
        console.error("Maximum timeout reached, aborting retries");
        throw new Error("Maximum timeout reached while trying to fetch URL");
      }

      const res = await fetch(url, requestOptions);
      if (!res.ok) {
        console.error(`Fetch failed with status: ${res.status} ${res.statusText}`);
        throw new Error(`Failed to fetch Yad2: ${res.status} ${res.statusText}`);
      }
      console.log(`Successfully fetched URL: ${url}`);
      return await res.text();
    } catch (err) {
      console.error("Error fetching Yad2 response", err);
      retries -= 1;
      if (retries === 0) {
        console.error("Network error occurred after multiple retries");
        throw new Error("Network error occurred after multiple retries");
      }
      const delay = backoffDelay(3 - retries);
      console.log(`Retrying... (${3 - retries} attempts left, waiting for ${delay}ms)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Failed to fetch Yad2 response");
};

// Function to extract ad details from Yad2 HTML response
const scrapeItemsAndExtractAdDetails = async (url: string): Promise<any[]> => {
  console.log(`Scraping items from URL: ${url}`);
  const yad2Html = await getYad2Response(url);
  const $ = cheerio.load(yad2Html);

  const titleText = $("title").first().text();
  console.log(`Page title: ${titleText}`);
  if (titleText === "ShieldSquare Captcha") {
    console.error("Bot detection encountered, stopping scrape");
    throw new Error("Bot detection encountered, could not proceed");
  }

  // Define possible selectors for feed items to make the scraper resilient to HTML changes
  const possibleSelectors = ["[data-testid='item-basic']"];
  let $feedItems;

  // Attempt to find the feed items using different selectors
  for (const selector of possibleSelectors) {
    $feedItems = $(selector);
    if ($feedItems.length) {
      console.log(`Feed items found using selector: ${selector}`);
      break;
    }
  }

  if (!$feedItems || !$feedItems.length) {
    console.error("No feed items found on the page after trying multiple selectors");
    throw new Error("Could not find feed items on the page");
  }

  // Extract ad details dynamically, accounting for different potential structures
  const adDetails: Record<string, string>[] = [];
  $feedItems.each((_, elm) => {
    const imageUrl = $(elm).find("img[data-testid='image']").attr("src");
    const address = $(elm).find("[class^=item-data-content_heading]").eq(1).text().trim();
    const description = $(elm).find("[class^='item-data-content_itemInfoLine']").first().text().trim();
    const structure = $(elm).find("[class^=item-data-content_itemInfoLine]").eq(1).text().trim();
    const price = $(elm).find("[class^=price_price]").text().trim();
    const relativeLink = $(elm).find('a[class^="item-layout_itemLink"]').attr("href");

    let fullLink = "";
    if (relativeLink) {
      const baseUrl = "https://www.yad2.co.il";
      fullLink = `${baseUrl}${relativeLink}`;
    }

    adDetails.push({
      fullLink: fullLink || "",
      imageUrl: imageUrl || "",
      address,
      description,
      structure,
      price,
    });
  });

  console.log(`Extracted details for ${adDetails.length} ads`);
  return adDetails;
};

// Function to check for new items and update saved items list
const checkForNewItems = async (ads: any[], topic: string): Promise<any[]> => {
  console.log(`Checking for new items for topic: ${topic}`);
  const filePath = `./data/${topic}.json`;
  let savedAds = new Set<string>();

  try {
    if (fs.existsSync(filePath)) {
      const data = await readFile(filePath, "utf-8");
      try {
        savedAds = new Set(JSON.parse(data));
        console.log(`Loaded ${savedAds.size} saved ads for topic: ${topic}`);
      } catch (parseError) {
        console.error("Error parsing saved ads, reverting to empty set", parseError);
        savedAds = new Set<string>();
        // Optionally create a backup of the corrupted file
        await writeFile(`${filePath}.backup`, data);
        console.log(`Backup of corrupted data saved to ${filePath}.backup`);
      }
    } else {
      console.log(`Data file for topic ${topic} does not exist. Creating new file.`);
      await mkdir("data", { recursive: true });
      await writeFile(filePath, "[]");
    }
  } catch (e) {
    console.error("Error accessing saved ads", e);
    throw new Error(`Could not read or create ${filePath}`);
  }

  const newItems = ads.filter((ad) => !savedAds.has(ad.imageUrl));
  console.log(`Found ${newItems.length} new items for topic: ${topic}`);
  if (newItems.length > 0) {
    newItems.forEach((ad) => savedAds.add(ad.imageUrl));
    await writeFile(filePath, JSON.stringify(Array.from(savedAds), null, 2));
    console.log(`Updated saved ads for topic: ${topic}`);
    await createPushFlagForWorkflow();
  }
  return newItems;
};

// Function to create a push flag for CI/CD pipeline
const createPushFlagForWorkflow = async (): Promise<void> => {
  console.log("Creating push flag for CI/CD pipeline");
  await writeFile("push_me", "");
};

// Function to send a message via Telegram API
const sendTelegramMessage = async (chatId: string, text: string, apiToken: string): Promise<void> => {
  const url = `https://api.telegram.org/bot${apiToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }
    console.log(`Message sent successfully to chatId: ${chatId}`);
  } catch (error) {
    console.error("Error sending message via Telegram API", error);
    throw error;
  }
};

// Function to send a photo message via Telegram API
const sendTelegramPhotoMessage = async (
  chatId: string,
  photoUrl: string,
  caption: string,
  apiToken: string
): Promise<void> => {
  const url = `https://api.telegram.org/bot${apiToken}/sendPhoto`;
  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Failed to send photo message: ${response.statusText}`);
    }
    console.log(`Photo message sent successfully to chatId: ${chatId}`);
  } catch (error) {
    console.error("Error sending photo via Telegram API", error);
    throw error;
  }
};

// Function to perform scraping and send Telegram notifications
const scrape = async (topic: string, url: string): Promise<void> => {
  console.log(`Starting scrape for topic: ${topic}`);
  const apiToken = process.env.API_TOKEN || config.telegramApiToken;
  const chatId = process.env.CHAT_ID || config.chatId;
  if (!apiToken || !chatId) {
    console.error("Missing API_TOKEN or CHAT_ID");
    throw new Error("Missing API_TOKEN or CHAT_ID");
  }

  try {
    console.log(`Sent start message for topic: ${topic}`);
    const scrapeResults = await scrapeItemsAndExtractAdDetails(url);
    const newItems = await checkForNewItems(scrapeResults, topic);
    if (newItems.length > 0) {
      for (const item of newItems) {
        const msg = `${item.address}\n${item.description}\n${item.structure}\n${item.price}\n\n${item.fullLink}`;
        if (item.imageUrl) {
          await sendTelegramPhotoMessage(chatId, item.imageUrl, msg, apiToken);
        } else {
          await sendTelegramMessage(chatId, msg, apiToken);
        }
        console.log(`Sent new item to chatId: ${chatId}`);
      }
    } else {
      console.log(`No new items found for topic: ${topic}`);
    }
  } catch (e: any) {
    const errMsg = e?.message || "Unknown error occurred";
    await sendTelegramMessage(chatId, `Scan workflow failed... 😥\nError: ${errMsg}`, apiToken);
    console.error("Error during scraping", e);
  }
};

// Main function to iterate through all projects and perform scraping
const main = async (): Promise<void> => {
  console.log("Starting main scraping process");
  const configData: Config = config;
  const limit = pLimit(3);

  const scrapePromises = configData.projects
    .filter((project) => {
      if (project.disabled) {
        console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        return false;
      }
      console.log(`Adding topic "${project.topic}" to scraping queue`);
      return true;
    })
    .map((project) =>
      limit(() =>
        scrape(project.topic, project.url).catch((e) => {
          console.error(`Error scraping topic: ${project.topic}`, e);
        })
      )
    );

  await Promise.all(scrapePromises);
  console.log("Completed all scraping tasks");
};

// Execute the main program
main().catch((e) => {
  console.error("Unhandled error in the program", e);
  process.exit(1);
});
