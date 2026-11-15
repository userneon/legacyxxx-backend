import "dotenv/config";
import { deriveEnv } from "./deriveEnv";

// Imported first: every module that loads after this sees the derived addresses.
deriveEnv();
