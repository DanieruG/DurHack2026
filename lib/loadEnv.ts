// Load env for CLI scripts (Next.js loads these itself): .env.local takes precedence over .env.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
