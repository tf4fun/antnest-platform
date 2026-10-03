import { z } from "zod";

// Configure before importing modules that construct frontend schemas. Zod's
// default eval probe reports a CSP violation even when it catches the failure.
z.config({ jitless: true });
