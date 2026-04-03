import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

function getBucket() {
  return process.env.R2_BUCKET!;
}

export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 600
): Promise<string> {
  return getSignedUrl(
    getR2Client(),
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn }
  );
}

export async function getSignedViewUrl(
  key: string,
  expiresIn = 3600
): Promise<string> {
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    { expiresIn }
  );
}

export async function deleteFromR2(key: string) {
  await getR2Client().send(
    new DeleteObjectCommand({ Bucket: getBucket(), Key: key })
  );
}
