import TelegramBot from "node-telegram-bot-api";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, unlink } from "fs";
import { promisify as promisifyFs } from "util";
import os from "os";
import path from "path";
import { logger } from "./lib/logger";

const execFileAsync = promisify(execFile);
const unlinkAsync = promisifyFs(unlink);

const MAX_TELEGRAM_SIZE = 50 * 1024 * 1024;

const URL_REGEX = /https?:\/\/[^\s]+/i;

function getTempPath(ext: string): string {
  return path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

async function getVideoInfo(url: string): Promise<{ title: string; filesize?: number }> {
  const { stdout } = await execFileAsync("yt-dlp", [
    "--dump-json",
    "--no-playlist",
    url,
  ]);
  const info = JSON.parse(stdout.trim());
  return { title: info.title || "Video", filesize: info.filesize };
}

async function downloadVideo(url: string, outPath: string): Promise<void> {
  await execFileAsync("yt-dlp", [
    "--no-playlist",
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "--max-filesize", "49m",
    "-o", outPath,
    url,
  ], { maxBuffer: 50 * 1024 * 1024 });
}

export function startBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }

  const bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram bot started (polling)");

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "👋 Send me a video link from YouTube, TikTok, Instagram, Twitter/X, or any supported site and I'll download it for you in the highest quality available.\n\nJust paste the URL and hit send!",
    );
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "🎬 *Video Downloader Bot*\n\nSupported sites include:\n• YouTube\n• TikTok\n• Instagram (Reels, posts)\n• Twitter / X\n• Facebook\n• Reddit\n• Vimeo\n• And 1000+ more sites!\n\nJust send a URL and I'll handle the rest.",
      { parse_mode: "Markdown" },
    );
  });

  bot.on("message", async (msg) => {
    const text = msg.text;
    if (!text) return;

    if (text.startsWith("/")) return;

    const match = text.match(URL_REGEX);
    if (!match) {
      await bot.sendMessage(
        msg.chat.id,
        "Please send a valid video URL. Use /help to see supported sites.",
      );
      return;
    }

    const url = match[0];
    const chatId = msg.chat.id;

    const statusMsg = await bot.sendMessage(chatId, "⏳ Fetching video info...");

    const outPath = getTempPath("mp4");

    try {
      let info: { title: string; filesize?: number };
      try {
        info = await getVideoInfo(url);
      } catch {
        await bot.editMessageText("❌ Couldn't fetch video info. Make sure the link is valid and the video is public.", {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        return;
      }

      await bot.editMessageText(`⬇️ Downloading: *${info.title}*...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
      });

      try {
        await downloadVideo(url, outPath);
      } catch (err: unknown) {
        const msg2 = err instanceof Error ? err.message : String(err);
        if (msg2.includes("File is larger than max-filesize")) {
          await bot.editMessageText(
            "❌ The video exceeds Telegram's 50 MB file limit. Try a shorter clip.",
            { chat_id: chatId, message_id: statusMsg.message_id },
          );
        } else {
          logger.error({ err, url }, "yt-dlp download failed");
          await bot.editMessageText(
            "❌ Download failed. The site may not be supported or the video may be private.",
            { chat_id: chatId, message_id: statusMsg.message_id },
          );
        }
        return;
      }

      await bot.editMessageText(`📤 Uploading: *${info.title}*...`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
      });

      await bot.sendVideo(chatId, createReadStream(outPath), {
        caption: info.title,
        supports_streaming: true,
      });

      await bot.deleteMessage(chatId, statusMsg.message_id);
    } catch (err) {
      logger.error({ err, url }, "Unexpected bot error");
      await bot.editMessageText(
        "❌ Something went wrong. Please try again.",
        { chat_id: chatId, message_id: statusMsg.message_id },
      );
    } finally {
      unlinkAsync(outPath).catch(() => {});
    }
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });
}
