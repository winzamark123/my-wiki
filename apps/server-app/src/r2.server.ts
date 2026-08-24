// paginated read of every object under a prefix; `headBytes` reads only the start of each object
export async function readObjects({
  bucket,
  prefix,
  headBytes,
}: {
  bucket: R2Bucket;
  prefix: string;
  headBytes?: number;
}) {
  const objects: { key: string; text: string }[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const batch = await Promise.all(
      listed.objects.map(async ({ key }) => {
        const obj = await bucket.get(key, headBytes ? { range: { offset: 0, length: headBytes } } : {});
        return obj ? { key, text: await obj.text() } : null;
      }),
    );
    objects.push(...batch.filter((o) => o !== null));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}
