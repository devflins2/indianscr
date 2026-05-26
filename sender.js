const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const db = require('./database');
const { getDirectDownloadUrl, formatBytes, countdown } = require('./scraper');

function getProxyAgent() {
  if (config.provider.proxyUrl) {
    return new HttpsProxyAgent(config.provider.proxyUrl);
  }
  return null;
}

let telegramClient = null;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [SENDER] ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [SENDER] ❌ ${message}`, error?.message || error);
}

/**
 * Initialize Telegram client with session string
 */
async function initClient() {
  try {
    log('Initializing Telegram client...');

    const session = new StringSession(config.telegram.sessionString);

    telegramClient = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
      connectionRetries: 5,
      retryDelay: 3000,
      autoReconnect: true,
      requestRetries: 3,
    });

    await telegramClient.connect();

    // Verify connection
    const me = await telegramClient.getMe();
    log(`✅ Logged in as: ${me.firstName} ${me.lastName || ''} (@${me.username || 'no_username'})`);

    return telegramClient;
  } catch (error) {
    logError('Failed to initialize Telegram client', error);
    throw error;
  }
}

/**
 * Disconnect Telegram client
 */
async function disconnectClient() {
  try {
    if (telegramClient) {
      await telegramClient.disconnect();
      log('Telegram client disconnected');
    }
  } catch (error) {
    logError('Error disconnecting client', error);
  }
}

/**
 * Build caption for the video message
 */
function buildCaption(video) {
  const lines = [
    `🎬 **${escapeMarkdown(video.title)}**`,
    '',
    `⏱ **Duration:** ${video.duration}`,
    `👁 **Views:** ${formatNumber(video.views)}`,
    `⭐ **Rating:** ${video.rating}%`,
    '',
    `🔗 [Watch Online](${video.page_url})`,
  ];

  return lines.join('\n');
}

/**
 * Escape markdown special characters
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (!num) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Download video file to temporary location
 */
async function downloadVideo(url, videoId) {
  const tempDir = path.join(__dirname, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filePath = path.join(tempDir, `${videoId}.mp4`);

  // Skip if already downloaded
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    if (stats.size > 0) {
      log(`File already exists: ${filePath} (${formatBytes(stats.size)})`);
      return filePath;
    }
  }

  log(`Downloading video ${videoId}...`);

  try {
    const axiosOptions = {
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 600000, // 10 min timeout for large files
      maxContentLength: config.limits.maxFileSizeBytes,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': config.provider.refererUrl || '',
      },
    };

    const agent = getProxyAgent();
    if (agent) {
      axiosOptions.httpsAgent = agent;
    }

    const response = await axios(axiosOptions);

    const contentLength = parseInt(response.headers['content-length'] || 0, 10);

    if (contentLength > config.limits.maxFileSizeBytes) {
      log(`⚠️ File too large: ${formatBytes(contentLength)} > 2GB. Skipping.`);
      return null;
    }

    if (contentLength > 0) {
      log(`File size: ${formatBytes(contentLength)}`);
    }

    const writer = fs.createWriteStream(filePath);
    let downloaded = 0;
    let lastLogTime = Date.now();

    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();

      // Log progress every 5 seconds
      if (now - lastLogTime > 5000) {
        const percent = contentLength > 0 ? ((downloaded / contentLength) * 100).toFixed(1) : '?';
        process.stdout.write(
          `\r[${new Date().toISOString()}] [SENDER] 📥 Downloading: ${formatBytes(downloaded)} / ${formatBytes(contentLength)} (${percent}%)   `
        );
        lastLogTime = now;
      }
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(''); // New line after progress
        log(`✅ Download complete: ${formatBytes(downloaded)}`);
        resolve(filePath);
      });

      writer.on('error', (err) => {
        console.log('');
        logError('Download write error', err);
        cleanupFile(filePath);
        reject(err);
      });

      response.data.on('error', (err) => {
        console.log('');
        logError('Download stream error', err);
        cleanupFile(filePath);
        reject(err);
      });
    });
  } catch (error) {
    logError(`Download failed for ${videoId}`, error);
    cleanupFile(filePath);
    return null;
  }
}

/**
 * Remove temporary file
 */
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log(`🗑️ Cleaned up: ${filePath}`);
    }
  } catch (err) {
    logError('Cleanup error', err);
  }
}

/**
 * Send a single video to the Telegram group
 */
async function sendVideoToGroup(video) {
  if (!telegramClient) {
    throw new Error('Telegram client not initialized');
  }

  let filePath = null;

  try {
    // Step 1: Get direct download URL
    log(`\n${'='.repeat(60)}`);
    log(`Processing: ${video.title.substring(0, 50)}...`);
    log(`Video ID: ${video.id}`);

    await countdown(config.delays.betweenApiCalls, 'Pre-download API delay');

    const downloadSource = await getDirectDownloadUrl(video.id);

    if (!downloadSource || !downloadSource.url) {
      log(`⚠️ No download URL available for ${video.id}. Skipping.`);
      return false;
    }

    // Step 2: Check file size
    if (downloadSource.filesize > config.limits.maxFileSizeBytes) {
      log(`⚠️ File too large (${formatBytes(downloadSource.filesize)}). Skipping.`);
      return false;
    }

    // Step 3: Download the video
    filePath = await downloadVideo(downloadSource.url, video.id);

    if (!filePath) {
      log(`⚠️ Download failed for ${video.id}. Skipping.`);
      return false;
    }

    // Verify file exists and has content
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      log(`⚠️ Downloaded file is empty. Skipping.`);
      cleanupFile(filePath);
      return false;
    }

    if (stats.size > config.limits.maxFileSizeBytes) {
      log(`⚠️ Downloaded file exceeds 2GB (${formatBytes(stats.size)}). Skipping.`);
      cleanupFile(filePath);
      return false;
    }

    log(`📤 Uploading to Telegram (${formatBytes(stats.size)})...`);

    // Step 4: Upload to Telegram
    const caption = buildCaption(video);
    const groupEntity = await resolveGroupEntity();

    // Upload progress callback
    const progressCallback = (progress) => {
      const percent = (progress * 100).toFixed(1);
      process.stdout.write(
        `\r[${new Date().toISOString()}] [SENDER] 📤 Uploading: ${percent}%   `
      );
    };

    await telegramClient.sendFile(groupEntity, {
      file: filePath,
      caption: caption,
      parseMode: 'md',
      supportsStreaming: true,
      progressCallback: progressCallback,
      attributes: [
        new Api.DocumentAttributeVideo({
          duration: video.duration_sec || 0,
          w: 1920,
          h: 1080,
          supportsStreaming: true,
        }),
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizeFilename(video.title)}.mp4`,
        }),
      ],
    });

    console.log(''); // New line after progress
    log(`✅ Successfully sent: ${video.title.substring(0, 50)}...`);

    return true;
  } catch (error) {
    console.log(''); // New line in case of progress bar
    logError(`Failed to send video ${video.id}`, error);

    // Check for specific Telegram errors
    if (error.message?.includes('FLOOD_WAIT')) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || '60', 10);
      log(`⚠️ Flood wait detected! Waiting ${waitTime} seconds...`);
      await countdown(waitTime, 'Flood wait');
    }

    return false;
  } finally {
    // Always cleanup the downloaded file
    if (filePath) {
      cleanupFile(filePath);
    }
  }
}

/**
 * Resolve the group entity from GROUP_ID
 */
let cachedGroupEntity = null;

async function resolveGroupEntity() {
  if (cachedGroupEntity) return cachedGroupEntity;

  try {
    const groupId = config.telegram.groupId;

    // Try different formats
    if (typeof groupId === 'string' && groupId.startsWith('@')) {
      cachedGroupEntity = await telegramClient.getEntity(groupId);
    } else {
      const numericId = BigInt(groupId);
      cachedGroupEntity = await telegramClient.getEntity(numericId);
    }

    log(`✅ Resolved group: ${cachedGroupEntity.title || cachedGroupEntity.id}`);
    return cachedGroupEntity;
  } catch (error) {
    logError('Failed to resolve group entity', error);
    throw error;
  }
}

/**
 * Sanitize filename
 */
function sanitizeFilename(name) {
  if (!name) return 'video';
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .trim();
}

/**
 * Process and send a batch of videos with all safety delays
 */
async function processBatch(videos) {
  let sentCount = 0;
  let failCount = 0;
  let skipCount = 0;

  const todayCount = await db.getTodaySentCount();
  const remaining = config.limits.maxVideosPerDay - todayCount;

  if (remaining <= 0) {
    log(`⚠️ Daily limit reached (${config.limits.maxVideosPerDay} videos). Waiting until tomorrow.`);
    return { sentCount: 0, failCount: 0, skipCount: videos.length };
  }

  const videosToProcess = videos.slice(0, remaining);
  log(`\n📋 Processing ${videosToProcess.length} videos (${todayCount} already sent today, limit: ${config.limits.maxVideosPerDay})`);

  for (let i = 0; i < videosToProcess.length; i++) {
    const video = videosToProcess[i];

    // Check daily limit again
    const currentDayCount = await db.getTodaySentCount();
    if (currentDayCount >= config.limits.maxVideosPerDay) {
      log(`⚠️ Daily limit reached during processing. Stopping.`);
      skipCount += videosToProcess.length - i;
      break;
    }

    // Check if already sent (double-check)
    const alreadySent = await db.isVideoSent(video.id);
    if (alreadySent) {
      log(`⏭️ Already sent: ${video.id}. Skipping.`);
      skipCount++;
      continue;
    }

    log(`\n📹 [${i + 1}/${videosToProcess.length}] Processing video...`);

    // Send the video
    const success = await sendVideoToGroup(video);

    if (success) {
      // Mark as sent in database
      await db.markVideoAsSent(video);
      sentCount++;

      // Save progress
      await db.saveState('last_processed_video_id', video.id);
      await db.saveState('last_send_time', new Date().toISOString());
    } else {
      failCount++;
    }

    // Anti-ban delay between sends
    if (i < videosToProcess.length - 1) {
      await countdown(config.delays.betweenSends, `Anti-ban delay before next video`);
    }

    // Extra delay every 10 videos
    if ((i + 1) % 10 === 0 && i < videosToProcess.length - 1) {
      log(`📊 Progress: ${sentCount} sent, ${failCount} failed, ${skipCount} skipped`);
      await countdown(60, 'Extended cooldown (every 10 videos)');
    }
  }

  log(`\n${'='.repeat(60)}`);
  log(`📊 Batch Complete!`);
  log(`   ✅ Sent: ${sentCount}`);
  log(`   ❌ Failed: ${failCount}`);
  log(`   ⏭️ Skipped: ${skipCount}`);
  log(`${'='.repeat(60)}\n`);

  return { sentCount, failCount, skipCount };
}

module.exports = {
  initClient,
  disconnectClient,
  sendVideoToGroup,
  processBatch,
  buildCaption,
};