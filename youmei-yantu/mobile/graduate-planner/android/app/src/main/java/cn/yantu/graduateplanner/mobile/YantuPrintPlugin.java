package cn.yantu.graduateplanner.mobile;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name="YantuPrint")
public class YantuPrintPlugin extends Plugin {
    @PluginMethod public void print(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager manager=(PrintManager)getActivity().getSystemService(Context.PRINT_SERVICE);
                if(manager==null){call.reject("此设备没有可用的打印服务");return;}
                manager.print("优酶研途规划",getBridge().getWebView().createPrintDocumentAdapter("优酶研途规划"),new PrintAttributes.Builder().build());
                call.resolve();
            } catch(Exception e){call.reject("无法打开打印界面",e);}
        });
    }
}
