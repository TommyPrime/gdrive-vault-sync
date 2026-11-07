import { type App, Modal } from "obsidian";
import { qrMatrix } from "./qr";

const MODULE_PX = 5;
/** QR の規格が求める周囲の余白。ダークテーマでも読めるよう、背景は常に白にする。 */
const QUIET_MODULES = 4;

function drawQr(canvas: HTMLCanvasElement, matrix: boolean[][]): void {
  const size = (matrix.length + QUIET_MODULES * 2) * MODULE_PX;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#000";
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return;
      context.fillRect((x + QUIET_MODULES) * MODULE_PX, (y + QUIET_MODULES) * MODULE_PX, MODULE_PX, MODULE_PX);
    });
  });
}

export class MobileTokenModal extends Modal {
  constructor(
    app: App,
    private readonly token: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("モバイル用トークン");
    contentEl.createEl("p", {
      text: "モバイルのカメラで QR を読み取り、表示された文字列をコピーして、モバイルの設定画面に貼り付けてください。",
    });
    contentEl.createEl("p", {
      text: "これを見た人は、あなたの Drive のこのプラグインのファイルに接続できます。写真に残さず、チャットやメールに貼らないでください。",
    });
    drawQr(contentEl.createEl("canvas"), qrMatrix(this.token));
    const text = contentEl.createEl("textarea", { text: this.token });
    text.readOnly = true;
    text.rows = 4;
    text.style.width = "100%";
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
