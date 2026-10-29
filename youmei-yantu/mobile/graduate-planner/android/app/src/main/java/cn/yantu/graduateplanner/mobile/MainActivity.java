package cn.yantu.graduateplanner.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this);
        registerPlugin(YantuPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
