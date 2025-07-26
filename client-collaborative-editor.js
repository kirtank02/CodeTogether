// ===== CLIENT-SIDE COLLABORATIVE EDITOR =====

class CollaborativeEditor {
    constructor(documentId, textareaElement) {
        this.documentId = documentId;
        this.textarea = textareaElement;
        this.socket = io();
        this.documentVersion = 0;
        this.pendingOperations = [];
        this.remoteUsers = new Map();
        
        this.setupSocketListeners();
        this.setupEditorEvents();
        this.joinDocument();
    }

    setupSocketListeners() {
        // Receive initial document state
        this.socket.on('document-state', (data) => {
            this.textarea.value = data.content;
            this.documentVersion = data.version;
            console.log('Document loaded, version:', this.documentVersion);
        });

        // Handle applied operations from server
        this.socket.on('operation-applied', (data) => {
            if (data.userId === this.socket.id) {
                // This is our operation coming back - remove from pending
                this.pendingOperations.shift();
                console.log('Own operation confirmed');
            } else {
                // This is a remote operation - apply it
                this.applyRemoteOperation(data.operation);
                console.log('Remote operation applied:', data.operation);
            }
            
            this.documentVersion = data.documentVersion;
        });

        // Handle cursor movements
        this.socket.on('cursor-moved', (data) => {
            this.updateRemoteCursor(data.userId, data.position, data.selection);
        });

        // Handle user join/leave
        this.socket.on('user-joined', (data) => {
            console.log('User joined:', data.userId);
            this.showUserIndicator(data.userId, 'joined');
        });

        this.socket.on('user-left', (data) => {
            console.log('User left:', data.userId);
            this.removeUserIndicator(data.userId);
        });
    }

    setupEditorEvents() {
        let lastContent = this.textarea.value;
        
        // Handle text input
        this.textarea.addEventListener('input', (e) => {
            const currentContent = this.textarea.value;
            const operation = this.detectOperation(lastContent, currentContent);
            
            if (operation) {
                this.sendOperation(operation);
                lastContent = currentContent;
            }
        });

        // Handle cursor/selection changes
        this.textarea.addEventListener('selectionchange', () => {
            this.sendCursorUpdate();
        });

        this.textarea.addEventListener('click', () => {
            this.sendCursorUpdate();
        });

        this.textarea.addEventListener('keyup', () => {
            this.sendCursorUpdate();
        });
    }

    // ===== OPERATION DETECTION =====
    detectOperation(oldContent, newContent) {
        // Simple diff algorithm to detect changes
        const oldLength = oldContent.length;
        const newLength = newContent.length;
        
        // Find the first difference
        let start = 0;
        while (start < oldLength && start < newLength && 
               oldContent[start] === newContent[start]) {
            start++;
        }
        
        // Find the last difference
        let oldEnd = oldLength;
        let newEnd = newLength;
        while (oldEnd > start && newEnd > start && 
               oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
            oldEnd--;
            newEnd--;
        }
        
        // Determine operation type
        if (start === oldEnd && start === newEnd) {
            return null; // No change
        } else if (start === oldEnd) {
            // Insertion
            return {
                type: 'insert',
                position: start,
                content: newContent.slice(start, newEnd)
            };
        } else if (start === newEnd) {
            // Deletion
            return {
                type: 'delete',
                position: start,
                length: oldEnd - start
            };
        } else {
            // Replacement
            return {
                type: 'replace',
                position: start,
                content: newContent.slice(start, newEnd),
                originalLength: oldEnd - start
            };
        }
    }

    // ===== SEND OPERATIONS =====
    sendOperation(operation) {
        // Add to pending operations
        this.pendingOperations.push(operation);
        
        // Send to server
        this.socket.emit('operation', {
            documentId: this.documentId,
            type: operation.type,
            position: operation.position,
            content: operation.content,
            length: operation.length,
            originalLength: operation.originalLength,
            clientVersion: this.documentVersion
        });
        
        console.log('Operation sent:', operation);
    }

    sendCursorUpdate() {
        const position = this.textarea.selectionStart;
        const selection = {
            start: this.textarea.selectionStart,
            end: this.textarea.selectionEnd
        };
        
        this.socket.emit('cursor-update', {
            documentId: this.documentId,
            position: position,
            selection: selection
        });
    }

    // ===== APPLY REMOTE OPERATIONS =====
    applyRemoteOperation(operation) {
        const currentContent = this.textarea.value;
        const cursorPosition = this.textarea.selectionStart;
        
        // Transform operation for any pending local operations
        let transformedOperation = this.transformForPendingOperations(operation);
        
        // Apply the operation
        const newContent = this.applyOperationToContent(currentContent, transformedOperation);
        
        // Calculate new cursor position
        const newCursorPosition = this.transformCursorPosition(
            cursorPosition, 
            transformedOperation
        );
        
        // Update textarea
        this.textarea.value = newContent;
        this.textarea.setSelectionRange(newCursorPosition, newCursorPosition);
    }

    transformForPendingOperations(operation) {
        let transformed = { ...operation };
        
        // Transform against all pending operations
        for (const pendingOp of this.pendingOperations) {
            transformed = this.transformOperations(transformed, pendingOp);
        }
        
        return transformed;
    }

    // ===== BASIC OPERATION TRANSFORMATION =====
    transformOperations(opA, opB) {
        const transformed = { ...opA };
        
        if (opA.type === 'insert' && opB.type === 'insert') {
            if (opB.position <= opA.position) {
                transformed.position += opB.content.length;
            }
        } else if (opA.type === 'insert' && opB.type === 'delete') {
            if (opB.position <= opA.position) {
                if (opB.position + opB.length <= opA.position) {
                    transformed.position -= opB.length;
                } else {
                    transformed.position = opB.position;
                }
            }
        } else if (opA.type === 'delete' && opB.type === 'insert') {
            if (opB.position <= opA.position) {
                transformed.position += opB.content.length;
            }
        }
        
        return transformed;
    }

    applyOperationToContent(content, operation) {
        switch (operation.type) {
            case 'insert':
                return content.slice(0, operation.position) + 
                       operation.content + 
                       content.slice(operation.position);
                       
            case 'delete':
                return content.slice(0, operation.position) + 
                       content.slice(operation.position + operation.length);
                       
            case 'replace':
                return content.slice(0, operation.position) + 
                       operation.content + 
                       content.slice(operation.position + operation.originalLength);
                       
            default:
                return content;
        }
    }

    transformCursorPosition(cursorPos, operation) {
        switch (operation.type) {
            case 'insert':
                if (operation.position <= cursorPos) {
                    return cursorPos + operation.content.length;
                }
                break;
                
            case 'delete':
                if (operation.position + operation.length <= cursorPos) {
                    return cursorPos - operation.length;
                } else if (operation.position < cursorPos) {
                    return operation.position;
                }
                break;
        }
        
        return cursorPos;
    }

    // ===== UI HELPERS =====
    updateRemoteCursor(userId, position, selection) {
        // Store remote user cursor info
        this.remoteUsers.set(userId, { position, selection });
        
        // Update UI to show remote cursors (simplified)
        this.renderRemoteCursors();
    }

    renderRemoteCursors() {
        // Remove existing cursor indicators
        document.querySelectorAll('.remote-cursor').forEach(el => el.remove());
        
        // Add new cursor indicators
        this.remoteUsers.forEach((data, userId) => {
            this.createCursorIndicator(userId, data.position);
        });
    }

    createCursorIndicator(userId, position) {
        // Create visual cursor indicator (simplified implementation)
        const indicator = document.createElement('div');
        indicator.className = 'remote-cursor';
        indicator.setAttribute('data-user', userId);
        indicator.style.position = 'absolute';
        indicator.style.backgroundColor = this.getUserColor(userId);
        indicator.style.width = '2px';
        indicator.style.height = '20px';
        indicator.style.zIndex = '1000';
        
        // Calculate position relative to textarea
        const rect = this.textarea.getBoundingClientRect();
        const textBeforeCursor = this.textarea.value.substring(0, position);
        const lines = textBeforeCursor.split('\n');
        const lineHeight = 20; // Approximate line height
        
        const top = rect.top + (lines.length - 1) * lineHeight;
        const left = rect.left + (lines[lines.length - 1].length * 8); // Approximate char width
        
        indicator.style.top = top + 'px';
        indicator.style.left = left + 'px';
        
        document.body.appendChild(indicator);
    }

    getUserColor(userId) {
        // Generate consistent color for user
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];
        const hash = userId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
        return colors[hash % colors.length];
    }

    showUserIndicator(userId, action) {
        // Show temporary notification
        const notification = document.createElement('div');
        notification.className = 'user-notification';
        notification.textContent = `User ${userId.substring(0, 8)} ${action}`;
        notification.style.position = 'fixed';
        notification.style.top = '10px';
        notification.style.right = '10px';
        notification.style.background = '#4ECDC4';
        notification.style.color = 'white';
        notification.style.padding = '8px 12px';
        notification.style.borderRadius = '4px';
        notification.style.zIndex = '1001';
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }

    removeUserIndicator(userId) {
        this.remoteUsers.delete(userId);
        this.renderRemoteCursors();
        
        // Remove any cursor indicators for this user
        document.querySelectorAll(`[data-user="${userId}"]`).forEach(el => el.remove());
    }

    joinDocument() {
        this.socket.emit('join-document', this.documentId);
    }

    // ===== DEBUGGING HELPERS =====
    getOperationHistory() {
        this.socket.emit('get-history', this.documentId);
        this.socket.on('operation-history', (history) => {
            console.log('Operation History:', history);
        });
    }

    getDocumentState() {
        return {
            content: this.textarea.value,
            version: this.documentVersion,
            pendingOperations: this.pendingOperations,
            remoteUsers: Array.from(this.remoteUsers.entries())
        };
    }
}

// ===== USAGE EXAMPLE =====
document.addEventListener('DOMContentLoaded', () => {
    const textarea = document.getElementById('editor');
    const documentId = 'demo-document'; // Could be dynamic
    
    if (textarea) {
        const editor = new CollaborativeEditor(documentId, textarea);
        
        // Make editor available globally for debugging
        window.collaborativeEditor = editor;
        
        // Add some debugging controls
        const debugPanel = document.createElement('div');
        debugPanel.innerHTML = `
            <div style="margin: 10px 0; padding: 10px; border: 1px solid #ccc;">
                <h3>Debug Controls</h3>
                <button onclick="window.collaborativeEditor.getOperationHistory()">Get History</button>
                <button onclick="console.log(window.collaborativeEditor.getDocumentState())">Get State</button>
                <div>Document Version: <span id="version-display">0</span></div>
                <div>Pending Operations: <span id="pending-display">0</span></div>
            </div>
        `;
        
        textarea.parentNode.insertBefore(debugPanel, textarea.nextSibling);
        
        // Update debug info periodically
        setInterval(() => {
            document.getElementById('version-display').textContent = editor.documentVersion;
            document.getElementById('pending-display').textContent = editor.pendingOperations.length;
        }, 1000);
    }
});

// ===== CSS FOR VISUAL INDICATORS =====
const style = document.createElement('style');
style.textContent = `
    .remote-cursor {
        pointer-events: none;
        animation: blink 1s infinite;
    }
    
    @keyframes blink {
        0%, 50% { opacity: 1; }
        51%, 100% { opacity: 0.3; }
    }
    
    .user-notification {
        animation: slideIn 0.3s ease-out;
    }
    
    @keyframes slideIn {
        from { transform: translateX(100%); }
        to { transform: translateX(0); }
    }
    
    #editor {
        width: 100%;
        height: 300px;
        font-family: monospace;
        font-size: 14px;
        line-height: 20px;
        padding: 10px;
        border: 1px solid #ccc;
        resize: vertical;
    }
`;
document.head.appendChild(style);