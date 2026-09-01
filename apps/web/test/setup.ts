import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom is shared across tests in a file; without this, a previous render's
// markup stays mounted and `getByText` starts matching the wrong component.
afterEach(cleanup);
