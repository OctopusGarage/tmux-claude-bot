import { exec } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import * as fs from "node:fs";
import * as nodePath from "node:path";

export async function transcribeOgg(filePath: string): Promise<string> {
  const MLX_WHISPER_BIN = process.env.MLX_WHISPER_BIN;
  if (!MLX_WHISPER_BIN) {
    throw new Error("MLX_WHISPER_BIN not configured. Set it in .env");
  }

  const resolved = nodePath.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Input file not found: ${resolved}`);
  }

  const parsed = nodePath.parse(resolved);
  const outputDir = os.tmpdir();

  await execAsync(`${MLX_WHISPER_BIN} ${resolved} --output-format txt --output-dir ${outputDir}`);

  const txtFile = nodePath.join(outputDir, `${parsed.name}.txt`);
  if (!fs.existsSync(txtFile)) {
    throw new Error(`Transcription output not found: ${txtFile}`);
  }
  const content = fs.readFileSync(txtFile, "utf-8").trim();
  fs.unlinkSync(txtFile);
  return content;
}
