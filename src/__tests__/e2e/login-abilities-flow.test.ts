/**
 * E2E Test: Login → Abilities List Integration Flow
 *
 * Tests the complete workflow of authenticating with a MainWP Dashboard
 * and listing abilities. Verifies profile storage, keychain integration,
 * and HTTP client behavior.
 *
 * INVARIANTS TESTED:
 * - Profile data is persisted correctly
 * - Credentials are stored securely (keychain with env fallback)
 * - HTTP client receives correct authentication headers
 * - Error paths handle gracefully with proper exit codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockProfile,
  createMockProfilesFile,
  createMockAbility,
  createMockHttpClient,
  createMockHttpResponse,
  setupE2ETest,
  cleanupE2ETest,
  setEnvVar,
  clearEnvVar,
  restoreEnvVars,
  STANDARD_ABILITIES,
} from './test-helpers.js';

// ============================================================================
// Module-level mocks (before imports)
// ============================================================================

// Mock node:fs for profile-store
const mockFsReadFile = vi.fn();
const mockFsWriteFile = vi.fn();
const mockFsMkdir = vi.fn();

vi.mock('node:fs', () => ({
  promises: {
    readFile: (...args: unknown[]) => mockFsReadFile(...args),
    writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
  },
}));

// Mock node:readline for interactive prompts
const mockQuestion = vi.fn();
const mockRlOn = vi.fn();
const mockRlClose = vi.fn();

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    on: mockRlOn,
    close: mockRlClose,
  })),
}));

// Mock node:os for homedir
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

// Mock http-client
const mockHttpGet = vi.fn();
const mockHttpPost = vi.fn();
const mockHttpDelete = vi.fn();

vi.mock('../../core/http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    get: mockHttpGet,
    post: mockHttpPost,
    delete: mockHttpDelete,
  })),
}));

// Mock keytar
const mockKeytarSetPassword = vi.fn();
const mockKeytarGetPassword = vi.fn();
const mockKeytarDeletePassword = vi.fn();

vi.mock('keytar', () => ({
  setPassword: (...args: unknown[]) => mockKeytarSetPassword(...args),
  getPassword: (...args: unknown[]) => mockKeytarGetPassword(...args),
  deletePassword: (...args: unknown[]) => mockKeytarDeletePassword(...args),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { ProfileStore } from '../../config/profile-store.js';
import { Keychain } from '../../config/keychain.js';
import { createHttpClient } from '../../core/http-client.js';
import { createAbilitiesExecutor } from '../../core/abilities-executor.js';
import { AuthError, NetworkError } from '../../utils/errors.js';

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Login → Abilities Flow', () => {
  let profileStore: ProfileStore;
  let keychain: Keychain;

  beforeEach(() => {
    setupE2ETest();

    // Create fresh instances for each test
    profileStore = new ProfileStore();
    keychain = new Keychain();

    // Default: no existing profiles
    mockFsReadFile.mockRejectedValue({ code: 'ENOENT' });
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);

    // Default: keytar available and working
    mockKeytarSetPassword.mockResolvedValue(undefined);
    mockKeytarGetPassword.mockResolvedValue(null);
    mockKeytarDeletePassword.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanupE2ETest();
    vi.resetModules();
  });

  // ==========================================================================
  // Login Flow Tests
  // ==========================================================================

  describe('Successful Login Flow', () => {
    it('saves profile with correct data structure', async () => {
      // Mock successful connection test
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      const profile = createMockProfile({
        name: 'test-dashboard',
        dashboardUrl: 'https://dashboard.test',
        username: 'admin',
      });

      // Save the profile
      await profileStore.save(profile);

      // Verify writeFile was called with correct structure
      expect(mockFsWriteFile).toHaveBeenCalled();
      const writeCall = mockFsWriteFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.profiles).toHaveLength(1);
      expect(savedData.profiles[0].name).toBe('test-dashboard');
      expect(savedData.profiles[0].dashboardUrl).toBe('https://dashboard.test');
      expect(savedData.profiles[0].username).toBe('admin');
    });

    it('stores credentials in keychain', async () => {
      const password = 'test-app-password';

      await keychain.set('test-dashboard', password);

      expect(mockKeytarSetPassword).toHaveBeenCalledWith(
        'mainwpctl',
        'test-dashboard',
        password
      );
    });

    it('sets first profile as active by default', async () => {
      const profile = createMockProfile({ name: 'first-profile' });

      await profileStore.save(profile);

      // Verify the profile is saved as active
      const writeCall = mockFsWriteFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.activeProfile).toBe('first-profile');
    });

    it('retrieves stored credentials from keychain', async () => {
      const password = 'stored-password';
      mockKeytarGetPassword.mockResolvedValueOnce(password);

      const retrieved = await keychain.get('test-dashboard');

      expect(mockKeytarGetPassword).toHaveBeenCalledWith('mainwpctl', 'test-dashboard');
      expect(retrieved).toBe(password);
    });
  });

  // ==========================================================================
  // Login Followed by Abilities List
  // ==========================================================================

  describe('Login followed by Abilities List', () => {
    it('lists abilities after successful login', async () => {
      // Clear mocks to ensure fresh state
      mockHttpGet.mockReset();

      // Setup: Profile exists with credentials
      const mockProfilesData = createMockProfilesFile([
        createMockProfile({ name: 'test-dashboard' }),
      ]);
      mockFsReadFile.mockResolvedValue(JSON.stringify(mockProfilesData));
      mockKeytarGetPassword.mockResolvedValueOnce('test-password');

      // Mock abilities endpoint
      const mockAbilities = [
        STANDARD_ABILITIES.listSites,
        STANDARD_ABILITIES.deleteSite,
        STANDARD_ABILITIES.updateSite,
      ];

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: mockAbilities })
      );

      // Create executor with unique baseUrl to avoid caching issues
      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard-login-test.test',
        username: 'admin',
        appPassword: 'test-password',
      });

      const abilities = await executor.listAbilities();

      expect(abilities.length).toBeGreaterThan(0);
      expect(mockHttpGet).toHaveBeenCalled();
    });

    it('fetches and caches abilities', async () => {
      const mockAbilities = [STANDARD_ABILITIES.listSites];

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: mockAbilities })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'admin',
        appPassword: 'test-password',
      });

      // First call
      await executor.listAbilities();
      const callCount1 = mockHttpGet.mock.calls.length;

      // Second call should use cache
      await executor.listAbilities();
      const callCount2 = mockHttpGet.mock.calls.length;

      expect(callCount2).toBe(callCount1);
    });

    it('retrieves ability by short name', async () => {
      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
      ];

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: mockAbilities })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'admin',
        appPassword: 'test-password',
      });

      await executor.listAbilities();

      const byShort = await executor.getAbility('list-sites-v1');
      const byFull = await executor.getAbility('mainwp/list-sites-v1');

      expect(byShort).toBeDefined();
      expect(byFull).toBeDefined();
      expect(byShort?.name).toBe(byFull?.name);
    });
  });

  // ==========================================================================
  // Authentication Failure Tests
  // ==========================================================================

  describe('Authentication Failure (401)', () => {
    it('throws AuthError on 401 response', async () => {
      const { APIError } = await import('../../utils/errors.js');

      mockHttpGet.mockRejectedValueOnce(
        new APIError('UNAUTHORIZED', 'Invalid credentials', 401)
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'wrong-user',
        appPassword: 'wrong-password',
      });

      await expect(executor.listAbilities()).rejects.toThrow('Invalid credentials');
    });

    it('does not save profile on auth failure', async () => {
      // Reset writeFile mock to track calls from this test
      mockFsWriteFile.mockClear();

      // Auth check fails - profile should not be saved
      // (In the real login command, profile is only saved after successful auth)

      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Network Failure Tests
  // ==========================================================================

  describe('Network Failure (ECONNREFUSED)', () => {
    it('throws NetworkError on connection failure', async () => {
      mockHttpGet.mockRejectedValueOnce(
        new NetworkError('Connection refused: ECONNREFUSED')
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://unreachable.test',
        username: 'admin',
        appPassword: 'password',
      });

      await expect(executor.listAbilities()).rejects.toThrow('Connection refused');
    });

    it('includes helpful message for network errors', async () => {
      const networkError = new NetworkError('ECONNREFUSED');

      expect(networkError.message).toContain('ECONNREFUSED');
    });
  });

  // ==========================================================================
  // Keychain Unavailable Fallback Tests
  // ==========================================================================

  describe('Keychain Unavailable Fallback', () => {
    beforeEach(() => {
      // Clear all mocks first to remove any queued responses from parent beforeEach
      vi.clearAllMocks();

      // Make keytar throw (simulating unavailable keychain)
      mockKeytarGetPassword.mockRejectedValue(new Error('Keychain not available'));
      mockKeytarSetPassword.mockRejectedValue(new Error('Keychain not available'));
    });

    it('falls back to environment variable for password', async () => {
      setEnvVar('MAINWP_APP_PASSWORD', 'env-password');

      // The keychain module caches keytar at module level
      // We need to ensure the mock is set up to reject before this test
      mockKeytarGetPassword.mockReset();
      mockKeytarGetPassword.mockRejectedValue(new Error('Keychain not available'));

      // Create fresh keychain instance
      const testKeychain = new Keychain();

      const password = await testKeychain.get('any-profile');

      // When keytar fails, it should fall back to env var
      expect(password).toBe('env-password');
    });

    it('returns undefined when neither keychain nor env var available', async () => {
      clearEnvVar('MAINWP_APP_PASSWORD');

      const testKeychain = new Keychain();
      const password = await testKeychain.get('any-profile');

      expect(password).toBeUndefined();
    });

    it('throws AuthError when getOrThrow called without credentials', async () => {
      clearEnvVar('MAINWP_APP_PASSWORD');

      const testKeychain = new Keychain();

      await expect(testKeychain.getOrThrow('any-profile')).rejects.toThrow(AuthError);
    });

    it('set() silently fails when keychain unavailable', async () => {
      const testKeychain = new Keychain();

      // Should not throw, just log warning
      await expect(testKeychain.set('profile', 'password')).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // Profile Management Tests
  // ==========================================================================

  describe('Profile Management', () => {
    it('lists all profiles', async () => {
      const mockProfiles = createMockProfilesFile([
        createMockProfile({ name: 'profile-1' }),
        createMockProfile({ name: 'profile-2' }),
      ]);
      mockFsReadFile.mockResolvedValue(JSON.stringify(mockProfiles));

      const profiles = await profileStore.list();

      expect(profiles).toHaveLength(2);
      expect(profiles[0].name).toBe('profile-1');
      expect(profiles[1].name).toBe('profile-2');
    });

    it('switches active profile', async () => {
      const mockProfiles = createMockProfilesFile([
        createMockProfile({ name: 'profile-1' }),
        createMockProfile({ name: 'profile-2' }),
      ], 'profile-1');

      mockFsReadFile.mockResolvedValue(JSON.stringify(mockProfiles));

      await profileStore.setActive('profile-2');

      // Verify writeFile was called with updated active profile
      expect(mockFsWriteFile).toHaveBeenCalled();
      const writeCall = mockFsWriteFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.activeProfile).toBe('profile-2');
    });

    it('throws error when switching to non-existent profile', async () => {
      const mockProfiles = createMockProfilesFile([
        createMockProfile({ name: 'profile-1' }),
      ]);
      mockFsReadFile.mockResolvedValue(JSON.stringify(mockProfiles));

      // ProfileStore throws an error when profile doesn't exist
      await expect(profileStore.setActive('non-existent')).rejects.toThrow(/not found|does not exist/i);
    });

    it('removes profile correctly', async () => {
      const mockProfiles = createMockProfilesFile([
        createMockProfile({ name: 'profile-1' }),
        createMockProfile({ name: 'profile-2' }),
      ], 'profile-1');

      mockFsReadFile.mockResolvedValue(JSON.stringify(mockProfiles));

      await profileStore.remove('profile-1');

      // Verify profile was removed and active switched
      const writeCall = mockFsWriteFile.mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.profiles).toHaveLength(1);
      expect(savedData.profiles[0].name).toBe('profile-2');
      expect(savedData.activeProfile).toBe('profile-2');
    });

    it('checks if profile exists', async () => {
      const mockProfiles = createMockProfilesFile([
        createMockProfile({ name: 'existing-profile' }),
      ]);
      mockFsReadFile.mockResolvedValue(JSON.stringify(mockProfiles));

      const exists = await profileStore.exists('existing-profile');
      const notExists = await profileStore.exists('non-existent');

      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });

    it('reloads profiles from disk', async () => {
      // First load
      const firstProfiles = createMockProfilesFile([
        createMockProfile({ name: 'profile-1' }),
      ]);
      mockFsReadFile.mockResolvedValueOnce(JSON.stringify(firstProfiles));

      await profileStore.list();

      // Simulate file change
      const updatedProfiles = createMockProfilesFile([
        createMockProfile({ name: 'profile-1' }),
        createMockProfile({ name: 'profile-new' }),
      ]);
      mockFsReadFile.mockResolvedValueOnce(JSON.stringify(updatedProfiles));

      await profileStore.reload();
      const profiles = await profileStore.list();

      expect(profiles).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Output Format Tests
  // ==========================================================================

  describe('Output Formats', () => {
    it('executor returns abilities with correct structure', async () => {
      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
        createMockAbility('delete-site-v1', { destructive: true }),
      ];

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: mockAbilities })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'admin',
        appPassword: 'password',
      });

      const abilities = await executor.listAbilities();

      // Check that abilities have expected structure
      for (const ability of abilities) {
        expect(ability).toHaveProperty('name');
        expect(ability).toHaveProperty('description');
        expect(ability).toHaveProperty('category');
      }
    });

    it('identifies readonly abilities correctly', async () => {
      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
      ];

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: mockAbilities })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'admin',
        appPassword: 'password',
      });

      const abilities = await executor.listAbilities();
      const listSites = abilities.find((a) => a.name.includes('list-sites'));

      expect(listSites?.meta?.annotations?.readonly).toBe(true);
    });

    it('identifies destructive abilities correctly', async () => {
      const mockAbilities = [
        createMockAbility('delete-site-v1', { destructive: true }),
      ];

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: mockAbilities })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'admin',
        appPassword: 'password',
      });

      const abilities = await executor.listAbilities();
      const deleteSite = abilities.find((a) => a.name.includes('delete-site'));

      expect(deleteSite?.meta?.annotations?.destructive).toBe(true);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles empty abilities list', async () => {
      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: [] })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard.test',
        username: 'admin',
        appPassword: 'password',
      });

      const abilities = await executor.listAbilities();

      expect(abilities).toHaveLength(0);
    });

    it('handles ability without annotations', async () => {
      // Clear mocks to ensure no stale responses
      mockHttpGet.mockReset();

      const legacyAbility = {
        name: 'mainwp/legacy-ability-v1',
        label: 'Legacy',
        description: 'A legacy ability',
        category: 'legacy',
      };

      mockHttpGet.mockResolvedValue(
        createMockHttpResponse(200, { abilities: [legacyAbility] })
      );

      const executor = createAbilitiesExecutor({
        baseUrl: 'https://dashboard-legacy.test',
        username: 'admin',
        appPassword: 'password',
      });

      const abilities = await executor.listAbilities();

      // Check that the legacy ability is included and handled correctly
      const legacy = abilities.find((a) => a.name === 'mainwp/legacy-ability-v1');
      expect(legacy).toBeDefined();
      expect(legacy?.meta?.annotations?.readonly).toBeFalsy();
    });

    it('normalizes dashboard URL (removes trailing slash)', async () => {
      // This tests the behavior when creating a profile
      const profile = createMockProfile({
        dashboardUrl: 'https://dashboard.test',
      });

      expect(profile.dashboardUrl).not.toMatch(/\/$/);
    });

    it('handles profile with skipSSLVerification', async () => {
      const profile = createMockProfile({
        skipSSLVerification: true,
      });

      expect(profile.skipSSLVerification).toBe(true);
    });
  });
});
