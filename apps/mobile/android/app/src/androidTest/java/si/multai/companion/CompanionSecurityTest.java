package si.multai.companion;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Native manifest boundaries on the installed APK, rather than the generated template package. */
@RunWith(AndroidJUnit4.class)
public class CompanionSecurityTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    private boolean handles(String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setPackage(context.getPackageName());
        return context.getPackageManager().resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null;
    }

    @Test
    public void credentialsCannotBeBackedUpAndInternetIsAvailable() {
        assertTrue(context.getPackageName().equals("si.multai.companion") || context.getPackageName().equals("si.multai.companion.test"));
        assertEquals(0, context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(android.Manifest.permission.INTERNET));
    }

    @Test
    public void onlyExactAppPathsAndThisBuildsCallbackAreRegistered() {
        boolean test = context.getPackageName().endsWith(".test");
        String origin = test ? "https://localhost" : "https://api.multai.si";
        String scheme = test ? "multai-companion-dev" : "multai-companion";
        String otherScheme = test ? "multai-companion" : "multai-companion-dev";
        assertTrue(handles(origin + "/app/#join=" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assertTrue(handles(origin + "/app#pair=K7Q2-M9XD-4TPR"));
        assertFalse(handles(origin + "/application#join=" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assertFalse(handles(origin + "/app/other#pair=K7Q2-M9XD-4TPR"));
        assertFalse(handles("https://example.com/app/#pair=K7Q2-M9XD-4TPR"));
        assertTrue(handles(scheme + "://auth/callback#signin=unused"));
        assertFalse(handles(otherScheme + "://auth/callback#signin=unused"));
    }
}
