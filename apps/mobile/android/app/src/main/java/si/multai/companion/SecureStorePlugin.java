package si.multai.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secrets encrypted with an AES-256-GCM key that lives in the Android Keystore and never leaves it.
 * Only ciphertext is written to app-private preferences, and app backup is disabled, so a copied data
 * folder cannot be decrypted elsewhere. Values are never logged.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String KEY_ALIAS = "multai_companion_secure_v1";
    private static final String PREFS = "multai_secure_v1";
    private static final Pattern NAME = Pattern.compile("^[a-zA-Z0-9._-]{1,64}$");

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String name(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !NAME.matcher(key).matches()) {
            call.reject("Invalid key name.", "invalid_key");
            return null;
        }
        return key;
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = name(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null || value.length() > 8192) { call.reject("Invalid value.", "invalid_value"); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            ByteBuffer out = ByteBuffer.allocate(1 + iv.length + sealed.length);
            out.put((byte) iv.length).put(iv).put(sealed);
            if (!prefs().edit().putString(key, Base64.encodeToString(out.array(), Base64.NO_WRAP)).commit()) throw new IllegalStateException("write failed");
            call.resolve();
        } catch (Exception error) {
            call.reject("Secure storage is unavailable.", "secure_storage_unavailable");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = name(call);
        if (key == null) return;
        String stored = prefs().getString(key, null);
        JSObject result = new JSObject();
        if (stored == null) { result.put("value", JSObject.NULL); call.resolve(result); return; }
        try {
            ByteBuffer in = ByteBuffer.wrap(Base64.decode(stored, Base64.NO_WRAP));
            byte[] iv = new byte[in.get() & 0xff];
            in.get(iv);
            byte[] sealed = new byte[in.remaining()];
            in.get(sealed);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            result.put("value", new String(cipher.doFinal(sealed), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            // A value that no longer decrypts (key removed, data tampered) is dropped, never returned.
            prefs().edit().remove(key).commit();
            result.put("value", JSObject.NULL);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = name(call);
        if (key == null) return;
        prefs().edit().remove(key).commit();
        call.resolve();
    }
}
