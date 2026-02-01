/**
 * Server-Sent Events for feed updates.
 * Notify connected clients when a post or story is created.
 */

const clients = new Set();

export function subscribeFeed(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.add(res);
    res.on('close', () => clients.delete(res));
}

export function notifyFeedUpdate() {
    const payload = JSON.stringify({ event: 'feed_update' });
    for (const client of clients) {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (err) {
            clients.delete(client);
        }
    }
}
