/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
}

const DAV_CLASS = "1";
const SUPPORT_METHODS = [
	"OPTIONS",
	"PROPFIND",
	"MKCOL",
	"GET",
	"HEAD",
	"PUT",
	"COPY",
	"MOVE",
];

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
}

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: undefined,
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: undefined,
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: undefined,
			resourcetype: '',
		};
	}

	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.key.endsWith('/') ? '<collection />' : '',
	};
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		if (request.headers.get('Authorization') !== `Basic ${btoa(`${env.USERNAME}:${env.PASSWORD}`)}`) {
			return new Response('Unauthorized', {
				status: 401, headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				}
			});
		}

		let response: Response;

		let resource_path = new URL(request.url).pathname.slice(1);

		switch (request.method) {
			case 'OPTIONS': {
				response = new Response(null, {
					status: 204,
					headers: {
						'DAV': DAV_CLASS,
						'Allow': SUPPORT_METHODS.join(', '),
					}
				});
			}
				break;
			case 'HEAD':
			case 'GET': {
				if (request.url.endsWith('/')) {
					let r2_objects = await bucket.list({
						prefix: resource_path,
						delimiter: '/',
					});
					let page = '';
					for (let dirname of r2_objects.delimitedPrefixes) {
						page += `<a href="${dirname}">${dirname}</a><br>`;
					}
					for (let object of r2_objects.objects.filter(object => !object.key.endsWith('/'))) {
						page += `<a href="${object.key}">${object.httpMetadata?.contentDisposition ?? object.key}</a><br>`;
					}
					response = new Response(page, { status: 200, headers: { 'Content-Type': 'text/html' } });
				} else {
					let object = await bucket.get(resource_path, {
						onlyIf: request.headers,
						range: request.headers,
					});

					let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
						return 'body' in object;
					}

					if (object === null) {
						response = new Response('Not Found', { status: 404 });
					} else if (!isR2ObjectBody(object)) {
						response = new Response("Precondition Failed", { status: 412 });
					} else {
						response = new Response(object.body, {
							status: object.range ? 206 : 200,
							headers: {
								'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
								// TODO: Content-Length, Content-Range

								...(object.httpMetadata?.contentDisposition ? {
									'Content-Disposition': object.httpMetadata.contentDisposition,
								} : {}),
								...(object.httpMetadata?.contentEncoding ? {
									'Content-Encoding': object.httpMetadata.contentEncoding,
								} : {}),
								...(object.httpMetadata?.contentLanguage ? {
									'Content-Language': object.httpMetadata.contentLanguage,
								} : {}),
								...(object.httpMetadata?.cacheControl ? {
									'Cache-Control': object.httpMetadata.cacheControl,
								} : {}),
								...(object.httpMetadata?.cacheExpiry ? {
									'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
								} : {}),
							}
						});
					}
				}
			}
				break;
			case 'PUT': {
				if (resource_path.endsWith('/')) {
					response = new Response('Method Not Allowed', { status: 405 });
					break;
				}

				// Check if the parent directory exists
				let dirpath = resource_path.split('/').slice(0, -1).join('/') + '/';
				let dir = await bucket.head(dirpath);
				if (!dir || dir.customMetadata?.resourcetype !== '<collection />') {
					response = new Response('Conflict', { status: 409 });
				}

				let body = await request.arrayBuffer();
				await bucket.put(resource_path, body, {
					onlyIf: request.headers,
					httpMetadata: request.headers,
				});
				response = new Response('', { status: 201 });
			}
				break;
			case 'DELETE': {
				if (resource_path.endsWith('/')) {
					let r2_objects = await bucket.list({
						prefix: resource_path,
					});
					await Promise.all(r2_objects.objects.map(
						object => bucket.delete(object.key)
					));
				} else {
					await bucket.delete(resource_path);
				}
				response = new Response(null, { status: 204 });
			}
				break;
			case 'MKCOL': {
				if (request.body) {
					response = new Response('Unsupported Media Type', { status: 415 });
					break;
				}

				resource_path = resource_path.endsWith('/') ? resource_path : resource_path + '/';

				// Check if the resource already exists
				if (await bucket.head(resource_path)) {
					response = new Response('Method Not Allowed', { status: 405 });
					break;
				}

				// Check if the parent directory exists
				let parent_dir = resource_path.split('/').slice(0, -2).join("/") + '/';

				if (parent_dir !== '/' && !await bucket.head(parent_dir)) {
					response = new Response('Conflict', { status: 409 });
					break;
				}

				await bucket.put(resource_path, new Uint8Array(), { httpMetadata: request.headers });
				response = new Response('', { status: 201 });
			}
				break;
			case 'PROPFIND': {
				let depth = request.headers.get('Depth') ?? 'infinity';
				switch (depth) {
					case '0': {
						if (resource_path === "") {
							response = new Response(`<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
	<response>
		<href>${resource_path}</href>
		<propstat>
			<prop>
				<resourcetype><collection /></resourcetype>
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>
</multistatus>
							`, {
								status: 207,
								headers: {
									'Content-Type': 'text/xml',
								},
							});
							break;
						}

						let object = await bucket.get(resource_path);
						if (object === null && !resource_path.endsWith('/')) {
							response = new Response('Not Found', { status: 404 });
						} else {
							let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
	<response>
		<href>${resource_path}</href>
		<propstat>
			<prop>
				${Object.entries(fromR2Object(object))
									.filter(([_, value]) => value !== undefined)
									.map(([key, value]) => `<${key}>${value}</${key}>`)
									.join('\n')
								}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>
</multistatus>
`;
							response = new Response(page, {
								status: 207,
								headers: {
									'Content-Type': 'text/xml',
								},
							});
						}
					}
						break;
					case '1': {
						let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

						let cursor: string | undefined = undefined;
						do {
							var r2_objects = await bucket.list({
								prefix: resource_path,
								delimiter: '/',
								cursor: cursor,
							});

							for (let dirname of r2_objects.delimitedPrefixes) {
								page += `
	<response>
		<href>${dirname}</href>
		<propstat>
			<prop>
				<resourcetype><collection /></resourcetype>
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
							}

							for (let object of r2_objects.objects.filter(object => !object.key.endsWith('/'))) {
								page += `
	<response>
		<href>${object.key}</href>
		<propstat>
			<prop>
				${Object.entries(fromR2Object(object))
										.filter(([_, value]) => value !== undefined)
										.map(([key, value]) => `<${key}>${value}</${key}>`)
										.join('\n				')
									}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
							}

							if (r2_objects.truncated) {
								cursor = r2_objects.cursor;
							}
						} while (r2_objects.truncated)
						page += '\n</multistatus>\n';
						response = new Response(page, {
							status: 207,
							headers: {
								'Content-Type': 'text/xml',
							},
						});
					}
						break;
					default: {
						response = new Response('Bad Request', { status: 400 });
					}
				}
			}
				break;
			case 'COPY': {
				let dont_overwrite = request.headers.get('Overwrite') === 'F';
				let destination_header = request.headers.get('Destination');
				if (destination_header === null) {
					response = new Response('Bad Request', { status: 400 });
					break;
				}
				let destination = new URL(destination_header).pathname.slice(1);
				let destination_exists = await bucket.head(destination);
				if (dont_overwrite && destination_exists) {
					response = new Response('Precondition Failed', { status: 412 });
					break;
				}
				if (resource_path.endsWith('/')) {
					let depth = request.headers.get('Depth') ?? 'infinity';
					switch (depth) {
						case 'infinity': {
							let r2_objects = await bucket.list({
								prefix: resource_path,
							});
							await Promise.all(r2_objects.objects.map(
								object => (async () => {
									let target = destination + object.key.slice(resource_path.length);
									let src = await bucket.get(object.key);
									if (src !== null) {
										await bucket.put(target, src.body, {
											httpMetadata: object.httpMetadata,
											customMetadata: object.customMetadata,
										});
									}
								})()
							));
							response = new Response('', { status: 201 });
						}
							break;
						case '0': {
							let object = await bucket.get(resource_path);
							if (object === null) {
								response = new Response('Not Found', { status: 404 });
								break;
							}
							await bucket.put(destination, object.body, {
								httpMetadata: object.httpMetadata,
								customMetadata: object.customMetadata,
							});
							response = new Response('', { status: 201 });
						}
							break;
						default: {
							response = new Response('Bad Request', { status: 400 });
						}
					}
				} else {
					let src = await bucket.get(resource_path);
					if (src === null) {
						response = new Response('Not Found', { status: 404 });
						break;
					}
					await bucket.put(destination, src.body, {
						httpMetadata: src.httpMetadata,
						customMetadata: src.customMetadata,
					});
					if (destination_exists) {
						response = new Response(null, { status: 204 });
					} else {
						response = new Response('', { status: 201 });
					}
				}
			}
				break;
			case 'MOVE': {
				let overwrite = request.headers.get('Overwrite') === 'T';
				let destination_header = request.headers.get('Destination');
				if (destination_header === null) {
					response = new Response('Bad Request', { status: 400 });
					break;
				}
				let destination = new URL(destination_header).pathname.slice(1);
				let destination_exists = await bucket.head(destination);
				if (destination_exists) {
					if (overwrite) {
						await Promise.all((await bucket.list({
							prefix: destination,
						})).objects.map(object => bucket.delete(object.key)));
					} else {
						response = new Response('Precondition Failed', { status: 412 });
						break;
					}
				}
				if (resource_path.endsWith('/')) {
					let depth = request.headers.get('Depth') ?? 'infinity';
					switch (depth) {
						case 'infinity': {
							let r2_objects = await bucket.list({
								prefix: resource_path,
							});
							await Promise.all(r2_objects.objects.map(
								object => (async () => {
									let target = destination + object.key.slice(resource_path.length);
									let src = await bucket.get(object.key);
									if (src !== null) {
										await bucket.put(target, src.body, {
											httpMetadata: object.httpMetadata,
											customMetadata: object.customMetadata,
										});
										await bucket.delete(object.key);
									}
								})()
							));
							response = new Response('', { status: 201 });
						}
							break;
						default: {
							response = new Response('Bad Request', { status: 400 });
						}
					}
				} else {
					let src = await bucket.get(resource_path);
					if (src === null) {
						response = new Response('Not Found', { status: 404 });
						break;
					}
					await bucket.put(destination, src.body, {
						httpMetadata: src.httpMetadata,
						customMetadata: src.customMetadata,
					});
					if (destination_exists) {
						response = new Response(null, { status: 204 });
					} else {
						response = new Response('', { status: 201 });
					}
				}
			}
			default: {
				response = new Response('Method Not Allowed', {
					status: 405,
					headers: {
						'Allow': SUPPORT_METHODS.join(', '),
						'DAV': DAV_CLASS,
					}
				});
			}
		}

		if (request.method === 'HEAD') {
			response = new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set('Access-Control-Allow-Headers',
			["authorization", "content-type", "depth", "overwrite", "destination", "range"].join(', ')
		);
		response.headers.set('Access-Control-Expose-Headers',
			["content-type", "content-length", "dav", "etag", "last-modified", "location", "date", "content-range"].join(', ')
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response
	},
};
