import { useState } from "react";
import { useAppSelector } from "@/store/hooks";
import { approvePendingOperations, rejectPendingOperations } from "@/lib/sessionManager";
import {
  loadStoredKey,
  decryptSecret,
  decryptBiometricKey,
  encryptSecret,
  encryptForBiometrics,
  blobIsLegacy,
  saveStoredKey,
} from "@/lib/vault";
import { unlockWithBiometrics } from "@/lib/secure";
import { accountKeys } from "@/store/accountsSlice";
import {
  missingKeyReason,
  pickKeyAuthority,
  requiredKeyAuthority,
  roleLabel,
  type KeyRole,
} from "@/lib/keyRouting";
import { hapticError, hapticMedium, hapticSuccess } from "@/lib/haptics";

/**
 * The one place an approval is unlocked and executed.
 *
 * The approval screen and the Approvals tab both offer Approve/Reject, and
 * they must not drift apart: the same authority check (never prompt for a key
 * this device does not hold), the same PIN/biometric gate, the same broadcast.
 * Only the presentation differs, so the screen-specific bits — snackbar text,
 * the authorizing flag that swaps buttons for the PIN pad — are returned
 * rather than rendered here.
 */
export function useApproval() {
  const pending = useAppSelector((s) => s.session.pending);
  const accounts = useAppSelector((s) => s.accounts.accounts);
  const activeUsername = useAppSelector((s) => s.accounts.activeUsername);

  const [authorizing, setAuthorizing] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  const activeAccount =
    accounts.find((a) => a.username === activeUsername) ?? accounts[0];

  /**
   * Which stored key may sign this request, decided BEFORE any PIN or
   * biometric prompt: an account can hold several keys now, and a request
   * that needs one this device does not have is refused here — with the name
   * of the key to add — instead of dying on-chain with an opaque
   * `missing active authority` error.
   */
  const requiredAuthority = pending
    ? requiredKeyAuthority(pending.ops, pending.sign)
    : null;
  const heldRoles: KeyRole[] = activeAccount
    ? (Object.keys(accountKeys(activeAccount)) as KeyRole[])
    : [];
  const usableKey = requiredAuthority ? pickKeyAuthority(heldRoles, requiredAuthority) : null;
  const blockedKeyReason =
    requiredAuthority && !usableKey
      ? missingKeyReason(heldRoles, requiredAuthority)
      : null;

  const approve = async (wif: string) => {
    try {
      await approvePendingOperations(wif);
      await hapticSuccess();
    } catch (e) {
      await hapticError();
      const message = e instanceof Error ? e.message : "Failed to broadcast.";
      // Visible in logcat: the in-browser sheet shows this too, but a failure
      // must never be diagnosable only by watching the screen.
      console.warn("[steemauth] approval failed:", message);
      setSnack(message);
    }
  };

  const biometricUnlock = async () => {
    if (!activeAccount) return;
    if (blockedKeyReason || !usableKey) {
      await hapticError();
      setSnack(blockedKeyReason ?? "No key on this device can sign this request.");
      return;
    }
    try {
      const record = await loadStoredKey(activeAccount.username, usableKey);
      if (!record) {
        setSnack(`Your ${roleLabel(usableKey)} key is not on this device.`);
        return;
      }
      if (!record.bioKey) {
        setSnack(
          `Biometric unlock is not set up for your ${roleLabel(usableKey)} key — use the PIN.`,
        );
        return;
      }
      const authed = await unlockWithBiometrics(activeAccount.username);
      if (!authed) return; // user cancelled the prompt
            const wif = await decryptBiometricKey(record.bioKey, activeAccount.username);
      if (!wif) {
        setSnack("Biometric unlock failed — use the PIN.");
        return;
      }
      // Same one-time migration for the biometric copy (device-secret password).
      if (blobIsLegacy(record.bioKey)) {
        void encryptForBiometrics(wif, activeAccount.username).then((bioKey) =>
          saveStoredKey({ ...record, bioKey }),
        );
      }
      await approve(wif);
    } catch (e) {
      setSnack(e instanceof Error ? e.message : "Unlock failed.");
    }
  };

  const pinUnlock = async (pin: string) => {
    if (!activeAccount) return;
    if (blockedKeyReason || !usableKey) {
      setSnack(blockedKeyReason ?? "No key on this device can sign this request.");
      setAuthorizing(false);
      return;
    }
    try {
      const record = await loadStoredKey(activeAccount.username, usableKey);
      if (!record) {
        setSnack(
          `Your ${roleLabel(usableKey)} key is not on this device — add it in Accounts.`,
        );
        return;
      }
            const wif = decryptSecret(record.encKey, pin);
      if (!wif) {
        setSnack("Could not decrypt the stored key.");
        return;
      }
      // One-time cost migration: re-encrypt at the current parameters so the
      // next approve starts from the fast (tagged) format. Best effort - a
      // missed write simply retries on the next unlock.
      if (blobIsLegacy(record.encKey)) {
        void saveStoredKey({ ...record, encKey: encryptSecret(wif, pin) });
      }
      await approve(wif);
    } catch (e) {
      setSnack(e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setAuthorizing(false);
    }
  };

  const reject = async () => {
    await hapticMedium();
    rejectPendingOperations();
  };

  return {
    activeAccount,
    usableKey,
    blockedKeyReason,
    authorizing,
    setAuthorizing,
    snack,
    setSnack,
    biometricUnlock,
    pinUnlock,
    reject,
  };
}
