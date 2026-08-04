package com.practiceplatform.validationengine.http;

import java.net.InetAddress;

public class AllowAllSsrfGuard extends SsrfGuard {
    @Override
    protected boolean isBlocked(InetAddress address) {
        return false;
    }
}
