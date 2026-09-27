// Pinned SDK Rpc.define returns this definition unchanged (apart from reserved-name validation).
export const Notifications = { id: "hooknostic-notification-probe", methods: { send: { input: { type: "object" }, output: { type: "object" } } }, events: {
  message: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
} };
