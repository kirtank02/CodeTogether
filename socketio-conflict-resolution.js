// ===== SERVER-SIDE CONFLICT RESOLUTION (Node.js + Socket.IO) =====

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Document state management
class DocumentManager {
    constructor() {
        this.documents = new Map(); // documentId -> DocumentState
        this.operationHistory = new Map(); // documentId -> Operation[]
        this.userCursors = new Map(); // documentId -> Map(userId -> cursor position)
    }

    getDocument(documentId) {
        if (!this.documents.has(documentId)) {
            this.documents.set(documentId, {
                content: '',
                version: 0,
                lastModified: Date.now()
            });
            this.operationHistory.set(documentId, []);
            this.userCursors.set(documentId, new Map());
        }
        return this.documents.get(documentId);
    }
}

// Operation types for collaborative editing
class Operation {
    constructor(type, position, content, userId, timestamp, documentVersion) {
        this.id = generateOperationId();
        this.type = type; // 'insert', 'delete', 'replace'
        this.position = position;
        this.content = content;
        this.userId = userId;
        this.timestamp = timestamp;
        this.documentVersion = documentVersion; // Version when operation was created
        this.length = content ? content.length : 0;
    }
}

// ===== CONFLICT RESOLUTION LOGIC =====
class ConflictResolver {
    
    // Main conflict resolution method using Operational Transformation
    static resolveConflicts(newOperation, concurrentOperations, documentContent) {
        let transformedOperation = { ...newOperation };
        
        // Sort concurrent operations by timestamp for consistent ordering
        const sortedOperations = concurrentOperations.sort((a, b) => {
            if (a.timestamp === b.timestamp) {
                // If timestamps are identical, use user ID for deterministic ordering
                return a.userId.localeCompare(b.userId);
            }
            return a.timestamp - b.timestamp;
        });

        // Transform the new operation against each concurrent operation
        for (const concurrentOp of sortedOperations) {
            transformedOperation = this.transformOperation(transformedOperation, concurrentOp);
        }

        return transformedOperation;
    }

    // Transform operation A against operation B (Operational Transformation)
    static transformOperation(opA, opB) {
        const transformed = { ...opA };

        // Case 1: Both operations are insertions
        if (opA.type === 'insert' && opB.type === 'insert') {
            if (opB.position <= opA.position) {
                // B's insertion is before A's position, shift A's position right
                transformed.position += opB.length;
            } else if (opB.position === opA.position) {
                // Same position conflict - use user ID for ordering
                if (opB.userId < opA.userId) {
                    transformed.position += opB.length;
                }
                // If A's user ID is smaller, A's operation stays at same position
            }
        }

        // Case 2: A is insertion, B is deletion
        else if (opA.type === 'insert' && opB.type === 'delete') {
            if (opB.position <= opA.position) {
                if (opB.position + opB.length <= opA.position) {
                    // B's deletion is completely before A's position
                    transformed.position -= opB.length;
                } else {
                    // B's deletion overlaps or contains A's position
                    transformed.position = opB.position;
                }
            }
        }

        // Case 3: A is deletion, B is insertion
        else if (opA.type === 'delete' && opB.type === 'insert') {
            if (opB.position <= opA.position) {
                // B's insertion is before A's deletion, shift A's position right
                transformed.position += opB.length;
            } else if (opB.position < opA.position + opA.length) {
                // B's insertion is within A's deletion range, adjust deletion length
                transformed.length += opB.length;
            }
        }

        // Case 4: Both operations are deletions
        else if (opA.type === 'delete' && opB.type === 'delete') {
            if (opB.position + opB.length <= opA.position) {
                // B's deletion is completely before A's deletion
                transformed.position -= opB.length;
            } else if (opB.position < opA.position + opA.length) {
                // Deletions overlap
                const overlapStart = Math.max(opA.position, opB.position);
                const overlapEnd = Math.min(opA.position + opA.length, opB.position + opB.length);
                const overlapLength = Math.max(0, overlapEnd - overlapStart);
                
                if (opB.position <= opA.position) {
                    transformed.position = opB.position;
                    transformed.length -= overlapLength;
                } else {
                    transformed.length -= overlapLength;
                }
                
                // If deletion is completely consumed, mark as no-op
                if (transformed.length <= 0) {
                    transformed.type = 'noop';
                }
            }
        }

        // Case 5: Replace operations (complex case)
        else if (opA.type === 'replace' || opB.type === 'replace') {
            // Convert replace to delete + insert and transform
            return this.transformReplaceOperation(opA, opB);
        }

        return transformed;
    }

    // Handle replace operations by converting to delete + insert
    static transformReplaceOperation(opA, opB) {
        if (opA.type === 'replace') {
            // Convert A's replace to delete + insert
            const deleteOp = new Operation('delete', opA.position, '', opA.userId, opA.timestamp, opA.documentVersion);
            deleteOp.length = opA.originalLength || opA.content.length;
            
            const insertOp = new Operation('insert', opA.position, opA.content, opA.userId, opA.timestamp, opA.documentVersion);
            
            // Transform both operations
            const transformedDelete = this.transformOperation(deleteOp, opB);
            const transformedInsert = this.transformOperation(insertOp, opB);
            
            // Combine back to replace
            return {
                ...opA,
                type: 'replace',
                position: transformedDelete.position,
                content: transformedInsert.content,
                length: transformedInsert.length
            };
        }
        
        // Similar logic for when opB is replace...
        return opA;
    }

    // Detect if operations conflict
    static hasConflict(opA, opB) {
        const aEnd = opA.position + (opA.length || opA.content.length);
        const bEnd = opB.position + (opB.length || opB.content.length);
        
        // Check for position overlap
        return !(aEnd <= opB.position || bEnd <= opA.position);
    }
}

// ===== DOCUMENT MANAGER WITH CONFLICT RESOLUTION =====
const documentManager = new DocumentManager();

// Apply operation to document content
function applyOperation(content, operation) {
    if (operation.type === 'noop') return content;
    
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

// Generate unique operation ID
function generateOperationId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ===== SOCKET.IO CONNECTION HANDLING =====
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Join document room
    socket.on('join-document', (documentId) => {
        socket.join(documentId);
        socket.documentId = documentId;
        
        const doc = documentManager.getDocument(documentId);
        
        // Send current document state to new user
        socket.emit('document-state', {
            content: doc.content,
            version: doc.version,
            cursors: Array.from(documentManager.userCursors.get(documentId).entries())
        });
        
        // Notify others of new user
        socket.to(documentId).emit('user-joined', {
            userId: socket.id,
            timestamp: Date.now()
        });
    });

    // ===== MAIN OPERATION HANDLING WITH CONFLICT RESOLUTION =====
    socket.on('operation', (operationData) => {
        const { documentId, type, position, content, clientVersion } = operationData;
        
        if (!documentId || socket.documentId !== documentId) return;
        
        const doc = documentManager.getDocument(documentId);
        const history = documentManager.operationHistory.get(documentId);
        
        // Create new operation
        const newOperation = new Operation(
            type,
            position,
            content,
            socket.id,
            Date.now(),
            clientVersion
        );

        // Find concurrent operations (operations that happened after client's version)
        const concurrentOperations = history.filter(op => 
            op.documentVersion >= clientVersion && op.userId !== socket.id
        );

        // ===== CONFLICT RESOLUTION HAPPENS HERE =====
        let transformedOperation = newOperation;
        
        if (concurrentOperations.length > 0) {
            console.log(`Resolving conflicts for operation ${newOperation.id}:`, {
                concurrent: concurrentOperations.length,
                newOp: { type, position, content: content?.substring(0, 20) + '...' }
            });
            
            transformedOperation = ConflictResolver.resolveConflicts(
                newOperation,
                concurrentOperations,
                doc.content
            );
        }

        // Apply the transformed operation to document
        const newContent = applyOperation(doc.content, transformedOperation);
        
        // Update document state
        doc.content = newContent;
        doc.version++;
        doc.lastModified = Date.now();
        
        // Add to history
        history.push(transformedOperation);
        
        // Keep only recent history (performance optimization)
        if (history.length > 1000) {
            history.splice(0, 100);
        }

        // ===== BROADCAST RESOLVED OPERATION =====
        const broadcastData = {
            operation: transformedOperation,
            documentVersion: doc.version,
            userId: socket.id,
            timestamp: Date.now()
        };

        // Send to all users in the document (including sender for confirmation)
        io.to(documentId).emit('operation-applied', broadcastData);
        
        // Log for debugging
        console.log(`Operation applied - Document ${documentId}, Version ${doc.version}`);
    });

    // Handle cursor position updates
    socket.on('cursor-update', (data) => {
        const { documentId, position, selection } = data;
        
        if (!documentId || socket.documentId !== documentId) return;
        
        const cursors = documentManager.userCursors.get(documentId);
        cursors.set(socket.id, { position, selection, timestamp: Date.now() });
        
        // Broadcast cursor position to others
        socket.to(documentId).emit('cursor-moved', {
            userId: socket.id,
            position,
            selection
        });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.documentId) {
            const cursors = documentManager.userCursors.get(socket.documentId);
            if (cursors) {
                cursors.delete(socket.id);
            }
            
            // Notify others of user leaving
            socket.to(socket.documentId).emit('user-left', {
                userId: socket.id,
                timestamp: Date.now()
            });
        }
    });

    // Get operation history for debugging/recovery
    socket.on('get-history', (documentId) => {
        const history = documentManager.operationHistory.get(documentId) || [];
        socket.emit('operation-history', history.slice(-50)); // Last 50 operations
    });
});

// ===== CONFLICT DETECTION MIDDLEWARE =====
function detectPotentialConflicts(operation, recentOperations) {
    const conflicts = [];
    
    for (const recentOp of recentOperations) {
        if (ConflictResolver.hasConflict(operation, recentOp)) {
            conflicts.push({
                type: 'position_conflict',
                operation1: operation,
                operation2: recentOp,
                severity: calculateConflictSeverity(operation, recentOp)
            });
        }
    }
    
    return conflicts;
}

function calculateConflictSeverity(opA, opB) {
    const overlap = calculateOverlap(opA, opB);
    if (overlap > 0.8) return 'high';
    if (overlap > 0.4) return 'medium';
    return 'low';
}

function calculateOverlap(opA, opB) {
    const aStart = opA.position;
    const aEnd = opA.position + (opA.length || opA.content.length);
    const bStart = opB.position;
    const bEnd = opB.position + (opB.length || opB.content.length);
    
    const overlapStart = Math.max(aStart, bStart);
    const overlapEnd = Math.min(aEnd, bEnd);
    const overlapLength = Math.max(0, overlapEnd - overlapStart);
    
    const totalLength = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
    return totalLength > 0 ? overlapLength / totalLength : 0;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Collaborative editor server running on port ${PORT}`);
    console.log('Conflict resolution system active');
});

module.exports = { DocumentManager, ConflictResolver, Operation };