// paginated read of every object under a prefix
export async function readObjects({ bucket, prefix }: { bucket: R2Bucket; prefix: string }) {
  const objects: { key: string; text: string }[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const batch = await Promise.all(
      listed.objects.map(async ({ key }) => {
        const obj = await bucket.get(key);
        return obj ? { key, text: await obj.text() } : null;
      }),
    );
    objects.push(...batch.filter((o) => o !== null));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function putJson({ bucket, key, value }: { bucket: R2Bucket; key: string; value: unknown }) {
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}
