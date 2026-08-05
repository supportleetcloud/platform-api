package com.practiceplatform.validationengine.http;

import java.net.InetAddress;
import java.net.UnknownHostException;

public class SsrfGuard {

    public static class BlockedHostException extends Exception {
        public BlockedHostException(String message) { super(message); }
    }

    public void check(String host) throws BlockedHostException, UnknownHostException {
        InetAddress[] addresses = InetAddress.getAllByName(host);
        for (InetAddress address : addresses) {
            if (isBlocked(address)) {
                throw new BlockedHostException(
                        "blocked target: " + host + " resolves to " + address.getHostAddress());
            }
        }
    }

    protected boolean isBlocked(InetAddress address) {
        if (address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress()
                || address.isAnyLocalAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        return bytes.length == 16 && (bytes[0] & 0xFE) == 0xFC;
    }
}
