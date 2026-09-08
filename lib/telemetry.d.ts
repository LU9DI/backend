// telemetry.d.ts – module shims for optional telemetry packages
declare module 'resend' {
  const Resend: any;
  export default Resend;
}

declare module 'posthog-node' {
  const PostHog: any;
  export default PostHog;
}
