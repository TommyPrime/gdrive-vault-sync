import SparkMD5 from "spark-md5";

export function md5OfBuffer(data: ArrayBuffer): string {
  return SparkMD5.ArrayBuffer.hash(data);
}
