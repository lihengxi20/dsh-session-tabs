/**
 * dsh-session-tabs — host half.
 *
 * This plugin is browser-only: the top session tabs live entirely in the web
 * client (lib/client.js), which dsh-client-modules serves as the package's
 * `/client` bundle. The host entry exists so the Loader tree owns a row for the
 * package; without it dsh-client-modules would never scan the `dsh.client`
 * declaration. Keep this module inert: DSH also loads it on non-web surfaces
 * (CLI, headless) where the tab UI must not exist.
 */

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-session-tabs";

/** Inert host plugin: the browser half owns every behavior. */
export function apply() {}
