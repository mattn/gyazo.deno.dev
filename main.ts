import { Buffer } from "https://deno.land/std/io/mod.ts";
import { Application, Context } from "https://deno.land/x/oak/mod.ts";
import { S3 } from "https://deno.land/x/s3@0.5.0/mod.ts";
import { Sha1 } from "https://deno.land/std@0.95.0/hash/sha1.ts";

const page = `
<!doctype html>
<link href="//fonts.bunny.net/css?family=sigmar-one:400" rel="stylesheet" />
<meta charset="utf-8" />
<title>Cloudflare Gyazo</title>
<style>
body {
  font-size: 40px;
  text-align: center;
}
h1,h2,h3 {
  font-family: 'Sigmar One', serif;
  font-style: normal;
  text-shadow: none;
  text-decoration: none;
  text-transform: none;
  letter-spacing: -0.05em;
  word-spacing: 0em;
  line-height: 1.15;
}
</style>
<body>
	<h1>Gyazo on Deno Deploy</h1>
	2022 (C) <a href="http://mattn.kaoriya.net/">mattn</a>, code is <a href="https://github.com/mattn/gyazo.deno.dev">here</a>
</body>
`;

const s3 = new S3({
  accessKeyID: Deno.env.get("AWS_ACCESS_KEY_ID")!,
  secretKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
  region: Deno.env.get("S3_REGION")!,
  endpointURL: Deno.env.get("S3_ENDPOINT_URL")!,
});

const bucket = await s3.getBucket(Deno.env.get("S3_BUCKET")!);

async function readerToBytes(
  reader: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const buf = new Buffer();
  const r = reader.getReader();
  try {
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      buf.write(value);
    }
  } finally {
    r.releaseLock();
  }
  return buf.bytes();
}

function basicAuthentication(request: Request) {
  const authorization = request.headers.get("Authorization")!;
  const [scheme, encoded] = authorization.split(" ");
  if (!encoded || scheme !== "Basic") {
    throw new Error("Malformed authorization header.");
  }
  const decoded = atob(encoded).normalize();
  const index = decoded.indexOf(":");
  if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
    throw new Error("Invalid authorization value.");
  }
  return {
    username: decoded.substring(0, index),
    password: decoded.substring(index + 1),
  };
}

function notAuthenticated(ctx: Context) {
  ctx.response.status = 401;
  ctx.response.type = "text/plain; charset=utf-8";
  ctx.response.headers.set(
    "www-authenticate",
    'Basic realm="Enter username and password.',
  );
  ctx.response.body = "Not Authenticated";
}

await new Application()
  .use(async (ctx) => {
    if (ctx.request.method === "GET") {
      const name = ctx.request.url.pathname;
      if (name === "/") {
        ctx.response.type = "text/html; charset=utf-8";
        ctx.response.body = page;
        return;
      }
      const obj = await bucket.getObject(name.slice(1))!;
      if (obj == null) {
        ctx.response.status = 404;
        ctx.response.type = "text/plain; charset=utf-8";
        ctx.response.body = "Not Found";
        return;
      }
      const bytes = await readerToBytes(obj.body);
      ctx.response.headers.set("ETag", obj.etag);
      ctx.response.headers.set("Content-Type", obj.contentType!);
      ctx.response.body = bytes;
    }
    if (ctx.request.method === "POST") {
      if (!ctx.request.headers.has("authorization")) {
        return notAuthenticated(ctx);
      }
      const { username, password } = basicAuthentication(ctx.request);
      if (
        username !== Deno.env.get("GYAZO_USERNAME") ||
        password !== Deno.env.get("GYAZO_PASSWORD")
      ) {
        return notAuthenticated(ctx);
      }
      const actual = await ctx.request.body({ type: "form-data" }).value.read({
        maxSize: 1000000,
      });
      const content = actual.files![0].content!;
      const sha1 = new Sha1();
      const name = sha1.update(content).hex().slice(0, 16) + ".png";
      await bucket.putObject(name, content, {
        contentType: "image/png",
      });
      ctx.response.type = "text/plain; charset=utf-8";
      ctx.response.body = ctx.request.url.toString() + name;
    }
  }).listen({ port: 8000 });
