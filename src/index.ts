import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xengyefjbnoolmqyphxw.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhlbmd5ZWZqYm5vb2xtcXlwaHh3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MDM5NjM5MSwiZXhwIjoyMDU1OTcyMzkxfQ._WvkO2VlHDrUKu-mFKmpwECApKidCoBLfE1xXc8pTZE";
const VIDEOS_TABLE = "videos";
const OUTPUT_BUCKET = "segments";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function convertVideoToHLS(videoUrl: string, folderName: string) {
  console.log(`▶ Converting ${videoUrl} to HLS (720p)...`);

  const tempDir = path.join("temp_hls", folderName);
  fs.mkdirSync(tempDir, { recursive: true });

  return new Promise<string | null>((resolve) => {
    const ffmpegArgs = [
      "-i", videoUrl,
      "-profile:v", "baseline",
      "-level", "3.1",
      "-s", "1280x720",
      "-start_number", "0",
      "-hls_time", "10",
      "-hls_list_size", "0",
      "-f", "hls",
      path.join(tempDir, "output.m3u8")
    ];

    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stdout.on("data", (data) => console.log(data.toString()));
    ffmpegProcess.stderr.on("data", (data) => console.log(data.toString()));

    ffmpegProcess.on("close", async (code) => {
      if (code !== 0) {
        console.error(`❌ FFmpeg exited with code ${code}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
        return resolve(null);
      }

      console.log("✅ HLS conversion finished");

      const files = fs.readdirSync(tempDir);
      let playlistUrl: string | null = null;

      for (const file of files) {
        const filePath = path.join(tempDir, file);
        const bucketPath = `${folderName}/${file}`;

        try {
          const { error } = await supabase.storage
            .from(OUTPUT_BUCKET)
            .upload(bucketPath, fs.readFileSync(filePath), { upsert: true });

          if (error) throw error;

          if (file.endsWith(".m3u8")) {
            playlistUrl = supabase.storage.from(OUTPUT_BUCKET).getPublicUrl(bucketPath).data.publicUrl;
          }

          console.log(`📤 Uploaded: ${bucketPath}`);
        } catch (err) {
          console.error(`❌ Failed to upload ${file}:`, err);
        }
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
      resolve(playlistUrl);
    });
  });
}

async function processVideos() {
  try {
    const { data: videos, error } = await supabase
      .from(VIDEOS_TABLE)
      .select("id, url, surveys(block)")
      .eq("surveys.block", "Gyaraspur")
      .not("id", "is", null);

    if (error) throw error;
    if (!videos || videos.length === 0) {
      console.log("No videos found to process");
      return;
    }

    for (const video of videos) {
      console.log(`🆕 Processing video: ${video.id}`);
      const folderName = video.id.toString().replace(/[^a-zA-Z0-9_-]/g, "_");
      const hlsUrl = await convertVideoToHLS(video.url, folderName);

      if (hlsUrl) {
        const { error: updateError } = await supabase
          .from(VIDEOS_TABLE)
          .update({ hls_url: hlsUrl })
          .eq("id", video.id);

        if (updateError) console.error(`❌ Failed to update video ${video.id}:`, updateError);
        else console.log(`✅ Updated video ${video.id} with HLS URL`);
      } else {
        console.log(`❌ Failed to convert video ${video.id}`);
      }
    }
  } catch (err) {
    console.error("❌ Error processing videos:", err);
  }
}

processVideos().then(() => console.log("✅ All videos processed"));
