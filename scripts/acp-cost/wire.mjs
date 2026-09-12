// Observe decoded JSON-RPC before SDK schemas can remove unknown fields.
export function observeWire(stream, updates, frames = []) {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(frame, controller) {
          frames.push(structuredClone(frame));
          if (frame.method === "session/update")
            updates.push(structuredClone(frame.params));
          controller.enqueue(frame);
        },
      }),
    ),
  };
}
