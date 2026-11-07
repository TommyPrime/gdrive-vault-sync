import qrcode from "qrcode-generator";

/** true が黒。誤り訂正は最低にする。画面の表示なので汚れず、QR を小さくできる。 */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "L");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => qr.isDark(row, column)),
  );
}
