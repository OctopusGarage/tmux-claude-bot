/**
 * Build a GitHub CLI command that is bound to the configured account.
 */
export function githubCommandForAccount(account: string | undefined, command: string): string {
  if (account === undefined || account.trim() === "") {
    throw new Error("GitHub automation requires an explicit githubAccount");
  }
  const quotedAccount = `'${account.replaceAll("'", "'\\''")}'`;
  return `GH_TOKEN="$(gh auth token --user ${quotedAccount})" gh ${command}`;
}

export function githubAccountRequirement(
  account: string | undefined,
  context: string,
): string | null {
  return account === undefined || account.trim() === ""
    ? `${context} requires an explicit githubAccount; refusing to use the global gh active account`
    : null;
}
